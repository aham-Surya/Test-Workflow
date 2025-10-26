// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- CONFIG ----
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const FB_REDIRECT_URI = process.env.FB_REDIRECT_URI;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const FB_API_VERSION = process.env.FB_API_VERSION || "v19.0";
const PORT = process.env.PORT || 3000;

// ---- SQLite DB ----
const DB_PATH = path.join(__dirname, "data.sqlite");
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY,
      page_id TEXT UNIQUE,
      page_name TEXT,
      page_access_token TEXT,
      subscribed INTEGER DEFAULT 0
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS whatsapp (
      id INTEGER PRIMARY KEY,
      phone_number_id TEXT UNIQUE,
      token TEXT,
      display_phone_number TEXT
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT,
      chat_id TEXT,
      sender_id TEXT,
      text TEXT,
      direction TEXT,
      timestamp INTEGER
    )
  `);
});

// ---- DB helpers ----
function dbInsertMessage(platform, chat_id, sender_id, text, direction) {
  db.run(
    `INSERT INTO messages (platform, chat_id, sender_id, text, direction, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    [platform, chat_id, sender_id, text, direction, Date.now()]
  );
}

function getAnyPage(callback) {
  db.get("SELECT * FROM pages LIMIT 1", (err, row) => {
    callback(row ? row : null);
  });
}

function getWhatsapp(callback) {
  db.get("SELECT * FROM whatsapp LIMIT 1", (err, row) => {
    callback(row ? row : null);
  });
}

// ---- Groq AI ----
async function generateAIReply(messages) {
  try {
    const res = await axios.post(
      "https://api.groq.com/v1/chat/completions",
      {
        model: "openai/gpt-oss-120b",
        messages: messages,
      },
      {
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );
    return res.data.choices[0].message.content;
  } catch (e) {
    console.error("Groq API error:", e.response?.data || e.message);
    return "Sorry, I can't respond right now.";
  }
}

// ---- Messenger send ----
async function sendMessengerMessage(pageToken, recipientId, text) {
  await axios.post(
    `https://graph.facebook.com/${FB_API_VERSION}/me/messages`,
    { recipient: { id: recipientId }, message: { text } },
    { params: { access_token: pageToken } }
  );
}

// ---- WhatsApp send ----
async function sendWhatsappMessage(phone_number_id, token, to_number, text) {
  await axios.post(
    `https://graph.facebook.com/${FB_API_VERSION}/${phone_number_id}/messages`,
    { messaging_product: "whatsapp", to: to_number, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );
}

// ---- Routes ----
app.get("/", (req, res) => {
  res.send("Meta Chatbot running!");
});

// Facebook OAuth connect
app.get("/connect", (req, res) => {
  const fb_oauth = `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?` +
    new URLSearchParams({
      client_id: FB_APP_ID,
      redirect_uri: FB_REDIRECT_URI,
      scope: "pages_show_list,pages_messaging,whatsapp_business_messaging,business_management",
      response_type: "code",
    });
  res.redirect(fb_oauth);
});

// Facebook OAuth callback
app.get("/facebook/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code returned");

  // Exchange code for user access token
  const tokenResp = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`, {
    params: { client_id: FB_APP_ID, redirect_uri: FB_REDIRECT_URI, client_secret: FB_APP_SECRET, code }
  });

  const userToken = tokenResp.data.access_token;

  // Get pages
  const pagesResp = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/me/accounts`, {
    params: { access_token: userToken }
  });

  const pages = pagesResp.data.data;
  if (pages.length > 0) {
    const page = pages[0];
    db.run(`INSERT OR REPLACE INTO pages (page_id, page_name, page_access_token, subscribed) VALUES (?, ?, ?, 1)`,
      [page.id, page.name, page.access_token]);
  }

  res.redirect("/");
});

// WhatsApp setup
app.post("/save_whatsapp", (req, res) => {
  const { phone_id, token, display } = req.body;
  if (!phone_id || !token) return res.status(400).send("phone_id and token required");
  db.run(`INSERT OR REPLACE INTO whatsapp (phone_number_id, token, display_phone_number) VALUES (?, ?, ?)`,
    [phone_id, token, display]);
  res.redirect("/");
});

// Webhook verification & handling
app.all("/webhook", async (req, res) => {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode && token === VERIFY_TOKEN) return res.send(challenge);
    return res.status(403).send("Verification failed");
  }

  const data = req.body;

  // Messenger messages
  if (data.entry) {
    for (const entry of data.entry) {
      if (entry.messaging) {
        for (const ev of entry.messaging) {
          if (ev.message && !ev.message.is_echo && ev.message.text) {
            const text = ev.message.text;
            const senderId = ev.sender.id;
            const chatId = entry.id || senderId;

            dbInsertMessage("messenger", chatId, senderId, text, "incoming");

            const messagesForAI = [
              { role: "system", content: "You are a helpful assistant." },
              { role: "user", content: text }
            ];
            const reply = await generateAIReply(messagesForAI);

            getAnyPage(async (page) => {
              if (page) {
                await sendMessengerMessage(page.page_access_token, senderId, reply);
                dbInsertMessage("messenger", chatId, "page", reply, "outgoing");
              }
            });
          }
        }
      }

      // WhatsApp messages
      if (entry.changes) {
        for (const change of entry.changes) {
          const value = change.value || {};
          const messages = value.messages || [];
          for (const m of messages) {
            if (m.text && m.text.body) {
              const txt = m.text.body;
              const fromNumber = m.from;
              const chatId = value.metadata?.phone_number_id || "";

              dbInsertMessage("whatsapp", chatId, fromNumber, txt, "incoming");

              getWhatsapp(async (wa) => {
                if (wa && wa.token && wa.phone_number_id) {
                  const reply = await generateAIReply([
                    { role: "system", content: "You are a helpful assistant." },
                    { role: "user", content: txt }
                  ]);
                  try {
                    await sendWhatsappMessage(wa.phone_number_id, wa.token, fromNumber, reply);
                    dbInsertMessage("whatsapp", wa.phone_number_id, "wa_bot", reply, "outgoing");
                  } catch (e) {
                    console.error("WA send failed:", e.message);
                  }
                }
              });
            }
          }
        }
      }
    }
  }

  res.send("EVENT_RECEIVED");
});

// Start server
app.listen(PORT, () => {
  console.log(`Meta Chatbot running on port ${PORT}`);
});
