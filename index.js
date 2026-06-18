import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

// ─── ENV VARIABLES ────────────────────────────────────────────────────────────
// Set these in your server environment or a .env file (use dotenv if preferred)
const WA_TOKEN        = process.env.WA_TOKEN;         // WhatsApp Cloud API token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;  // Your WA phone number ID
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;     // Any secret string you choose
const ANTHROPIC_KEY   = process.env.ANTHROPIC_KEY;    // Your Claude API key

// Claude model name can be overridden via environment variable `CLAUDE_MODEL`.
// Default kept as the previous model string for backward compatibility.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL;
const GOOGLE_SHEET_ID  = process.env.GOOGLE_SHEET_ID;   // from Google Sheets URL
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL; // from service account JSON
const GOOGLE_PRIVATE_KEY  = process.env.GOOGLE_PRIVATE_KEY;  // from service account JSON


// ─── STEP 1: WEBHOOK VERIFICATION ────────────────────────────────────────────
// Meta calls this GET route once when you register the webhook URL.
// It sends a challenge string — you must echo it back to confirm the URL is yours.
app.get("/sync", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified by Meta");
    res.status(200).send(challenge); // echo back the challenge
  } else {
    console.error("Webhook verification failed — token mismatch");
    res.sendStatus(403);
  }
});


// ─── STEP 2: RECEIVE INCOMING MESSAGES ───────────────────────────────────────
// Meta POSTs here every time someone sends a message to your WA number.
app.post("/sync", async (req, res) => {

  // Always reply 200 immediately — Meta will retry if you don't respond fast
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const message = changes?.messages?.[0];

    // Ignore non-message events (delivery receipts, read status, etc.)
    if (!message || message.type !== "text") return;

    const from        = message.from;          // sender's phone number e.g. "0123456789"
    const messageText = message.text.body;     // the actual message content
    const to          = changes?.metadata?.phone_number_id; // which of YOUR numbers received it

    console.log(`Message from ${from}: ${messageText}`);
    console.log("Message type:", message.type);

    // ── STEP 3: SEND TO CLAUDE ──────────────────────────────────────────────
    const invoiceData = await parseOrderWithClaude(message, from);

    // ── STEP 4: REPLY ON WHATSAPP ───────────────────────────────────────────
    if (invoiceData.error) {
      console.log("Claude parsing failed or message not an order:", invoiceData.reply);
      // Claude couldn't parse a valid order — ask for clarification
      await sendWhatsAppMessage(from, invoiceData.reply, to);
    } else {
      // Valid order parsed — confirm and send invoice summary
      console.log("Order parsed successfully:", invoiceData);
      const reply = buildConfirmationMessage(invoiceData);
      await sendWhatsAppMessage(from, reply, to);
    }

  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});


// ─── MAIN: PARSE ORDER (TEXT OR IMAGE) ───────────────────────────────────────
// Detects whether the incoming WhatsApp message is text or image
// and routes to the appropriate Claude call.
export async function parseOrderWithClaude(message, senderPhone) {

  const msgType = message.type;

  try {
    let parsed;
    console.log(`Parsing message of type "${msgType}" from ${senderPhone}`);
    if (msgType === "text") {
      // ── Text message ──────────────────────────────────────────────────────
      parsed = await parseTextOrder(message.text.body, senderPhone);

    } else if (msgType === "image") {
      // ── Image message ─────────────────────────────────────────────────────
      // Step 1: download the image from WhatsApp
      const imageBase64 = await downloadWhatsAppMedia(message.image.id);
      const mimeType    = message.image.mime_type || "image/jpeg";

      // Step 2: send to Claude vision
      parsed = await parseImageOrder(imageBase64, mimeType, senderPhone);

    } else {
      // ── Unsupported type (video, audio, doc, etc.) ────────────────────────
      return {
        error: true,
        reply: "Sorry, I can only process text messages or images of orders. Please send your order as text or a photo.",
      };
    }

    // ── Save to Google Sheets if valid order ─────────────────────────────────
    if (!parsed.error && parsed.isOrder) {
      await saveToGoogleSheets(parsed, senderPhone);
    }

    return parsed;

  } catch (err) {
    console.error("parseOrderWithClaude error:", err);
    return {
      error: true,
      reply: "Something went wrong processing your order. Please try again.",
    };
  }
}


// ─── TEXT ORDER PARSER ────────────────────────────────────────────────────────
async function parseTextOrder(messageText, senderPhone) {

  const prompt = buildOrderPrompt(`Message: "${messageText}"`, senderPhone);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  var responseJson = await response.json();
  console.log("Claude response:", JSON.stringify(responseJson));
  return extractParsedOrder(responseJson);
}


// ─── IMAGE ORDER PARSER ───────────────────────────────────────────────────────
// Sends the image to Claude with vision — Claude reads the order from the photo.
// Works for: handwritten orders, printed order forms, screenshots, photos of lists.
async function parseImageOrder(imageBase64, mimeType, senderPhone) {

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      messages: [{
        role: "user",
        content: [
          {
            // Pass the image directly to Claude vision
            type: "image",
            source: {
              type: "base64",
              media_type: mimeType,
              data: imageBase64,
            },
          },
          {
            type: "text",
            text: buildOrderPrompt("The order details are in the image above. Extract all visible items, quantities, and prices.", senderPhone),
          },
        ],
      }],
    }),
  });

  return extractParsedOrder(await response.json());
}


// ─── SHARED PROMPT BUILDER ────────────────────────────────────────────────────
// Same JSON structure expected whether input is text or image.
function buildOrderPrompt(inputDescription, senderPhone) {
  return `
You are a B2B order processing assistant.
${inputDescription}
Sender phone: ${senderPhone}

Extract the order details and respond ONLY with a valid JSON object — no explanation, no markdown, no code fences.

If this is a valid order:
{
  "isOrder": true,
  "sender": "${senderPhone}",
  "items": [
    { "name": "item name", "quantity": 10, "unitPrice": 25.00 }
  ],
  "notes": "any special instructions or empty string",
  "currency": "USD"
}

If NOT a valid order (greeting, question, unclear, or image doesn't show an order):
{
  "isOrder": false,
  "reply": "A friendly message asking them to clarify or send their order"
}

Rules:
- Be flexible: "50 units of widget A", "50x widget A", "pls send 50 widget A" all work.
- If price is missing or unclear, set unitPrice to null.
- Detect currency from context (AED, USD, EUR, GBP, SAR) — default USD if not mentioned.
- For images: read all visible text carefully including handwriting, tables, printed lists.
- If quantity is ambiguous, use the most likely value and mention it in notes.
`;
}


// ─── EXTRACT PARSED ORDER FROM CLAUDE RESPONSE ───────────────────────────────
function extractParsedOrder(data) {
  const raw   = data.content?.[0]?.text?.trim();
  const clean = raw?.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(clean);
    if (!parsed.isOrder) {
      return { error: true, reply: parsed.reply };
    }
    return parsed;
  } catch {
    console.error("Claude returned non-JSON:", raw);
    return {
      error: true,
      reply: "Sorry, I had trouble reading your order. Please resend it with item names and quantities — e.g. '50x Widget A, 20x Widget B'.",
    };
  }
}


// ─── DOWNLOAD WHATSAPP MEDIA ──────────────────────────────────────────────────
// WhatsApp images aren't sent as raw data — you get a media ID.
// You must call the Graph API to get the download URL, then fetch the image.
async function downloadWhatsAppMedia(mediaId) {

  const WA_TOKEN = process.env.WA_TOKEN;

  // Step 1: get the download URL from the media ID
  const metaRes  = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });
  const metaData = await metaRes.json();
  const mediaUrl = metaData.url;

  // Step 2: download the actual image bytes
  const imgRes  = await fetch(mediaUrl, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
  });
  const buffer  = await imgRes.arrayBuffer();

  // Step 3: convert to base64 for Claude
  return Buffer.from(buffer).toString("base64");
}


// ─── SAVE TO GOOGLE SHEETS ────────────────────────────────────────────────────
// Appends each order line item as a row in your Google Sheet.
// Sheet columns: Date | Invoice No | Sender | Item | Qty | Unit Price | Total | Currency | Notes
async function saveToGoogleSheets(order, senderPhone) {

  try {
    // Authenticate with Google using a Service Account
    const auth = new google.auth.JWT({
      email: GOOGLE_CLIENT_EMAIL,
      key:   GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n"), // fix escaped newlines from env var
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets    = google.sheets({ version: "v4", auth });
    const invoiceNo = `INV-${Date.now().toString().slice(-5)}`;
    const date      = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

    // Build one row per line item
    const rows = order.items.map((item) => {
      const lineTotal = item.unitPrice !== null
        ? (item.quantity * item.unitPrice).toFixed(2)
        : "TBC";

      return [
        date,                          // A: Date
        invoiceNo,                     // B: Invoice No
        senderPhone,                   // C: Sender Phone
        item.name,                     // D: Item Name
        item.quantity,                 // E: Quantity
        item.unitPrice ?? "TBC",       // F: Unit Price
        lineTotal,                     // G: Line Total
        order.currency,                // H: Currency
        order.notes || "",             // I: Notes
      ];
    });

    // Append all rows to the sheet in one API call
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEET_ID,
      range:         "Orders!A:I",     // sheet tab named "Orders"
      valueInputOption: "USER_ENTERED",
      requestBody: { values: rows },
    });

    console.log(`✅ Order saved to Google Sheets — ${rows.length} rows, invoice ${invoiceNo}`);
    return invoiceNo;

  } catch (err) {
    // Don't crash the webhook if Sheets fails — just log it
    console.error("❌ Google Sheets save failed:", err.message);
  }
}


// ─── BUILD CONFIRMATION MESSAGE ───────────────────────────────────────────────
// Formats the parsed order into a clean WhatsApp reply text.
function buildConfirmationMessage(order) {
  const symbol = currencySymbol(order.currency);
  let total    = 0;

  const lineItems = order.items.map((item) => {
    if (item.unitPrice !== null) {
      const lineTotal = item.quantity * item.unitPrice;
      total += lineTotal;
      return `  • ${item.name}: ${item.quantity} x ${symbol}${item.unitPrice.toFixed(2)} = ${symbol}${lineTotal.toFixed(2)}`;
    }
    return `  • ${item.name}: ${item.quantity} units (price TBC)`;
  }).join("\n");

  const hasPrices = order.items.every((i) => i.unitPrice !== null);

  let message = `Order received — here's your summary:\n\n${lineItems}`;

  if (hasPrices) {
    message += `\n\n  Total: ${symbol}${total.toFixed(2)} ${order.currency}`;
  }

  if (order.notes) {
    message += `\n\n  Notes: ${order.notes}`;
  }

  message += "\n\nWe'll send your invoice shortly. Reply CANCEL to cancel this order.";

  return message;
}

function currencySymbol(currency) {
  const map = { USD: "$", EUR: "€", GBP: "£", AED: "AED ", SAR: "SAR " };
  return map[currency] ?? (currency + " ");
}


// ─── SEND WHATSAPP MESSAGE ────────────────────────────────────────────────────
// Calls the WhatsApp Cloud API to send a text reply back to the sender.
// `phoneNumberId` is WHICH of your numbers sends the reply —
// this is what lets you run multiple numbers from one webhook.
async function sendWhatsAppMessage(to, text, phoneNumberId) {

  // Fall back to env var if not passed (single-number setup)
  const numId = phoneNumberId || PHONE_NUMBER_ID;

  const url = `https://graph.facebook.com/v19.0/${numId}/messages`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${WA_TOKEN}`,
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: text },
    }),
  });

  const result = await response.json();

  if (!response.ok) {
    console.error("WhatsApp send failed:", JSON.stringify(result));
  } else {
    console.log(`Reply sent to ${to}, message ID: ${result.messages?.[0]?.id}`);
  }
}


// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook server running on port ${PORT}`));
