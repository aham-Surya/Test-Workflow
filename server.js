require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const Groq = require("groq").default;

// ---- Config ----
const FB_API_VERSION = "v19.0";
const PORT = process.env.PORT || 3000;
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const BASE_URL = process.env.BASE_URL;
const FB_REDIRECT_URI = process.env.FB_REDIRECT_URI;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// ---- App Setup ----
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const groqClient = new Groq({ apiKey: GROQ_API_KEY });

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));

// ---- Database ----
const db = new sqlite3.Database("./data.sqlite", (err) => {
  if (err) console.error("DB Error:", err);
});

// Create tables if not exists
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY,
      page_id TEXT UNIQUE,
      page_name TEXT,
      page_access_token TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS whatsapp (
      id INTEGER PRIMARY KEY,
      phone_number_id TEXT UNIQUE,
      token TEXT,
      display_phone_number TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT,
      chat_id TEXT,
      sender_id TEXT,
      text TEXT,
      direction TEXT,
      timestamp INTEGER
  )`);
});

// ---- Helpers ----
const savePage = (page_id, page_name, token) => {
  db.run(
    `INSERT OR REPLACE INTO pages (page_id, page_name, page_access_token) VALUES (?, ?, ?)`,
    [page_id, page_name, token]
  );
};

const getAnyPage = async () => {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM pages LIMIT 1`, [], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const saveWhatsapp = (phone_number_id, token, display) => {
  db.run(
    `INSERT OR REPLACE INTO whatsapp (phone_number_id, token, display_phone_number) VALUES (?, ?, ?)`,
    [phone_number_id, token, display]
  );
};

const getWhatsapp = async () => {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM whatsapp LIMIT 1`, [], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const saveMessage = (platform, chat_id, sender_id, text, direction) => {
  const ts = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO messages (platform, chat_id, sender_id, text, direction, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    [platform, chat_id, sender_id, text, direction, ts]
  );
};

// AI reply with memory
let chatMemory = {}; // { chat_id: [{role, content}] }

const generateAIReply = async (chat_id, userText) => {
  chatMemory[chat_id] = chatMemory[chat_id] || [];
  chatMemory[chat_id].push({ role: "user", content: userText });

  const messages = chatMemory[chat_id].slice(-10); // last 10 messages

  try {
    const comp = await groqClient.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: messages,
    });
    const reply = comp.choices[0].message.content;
    chatMemory[chat_id].push({ role: "assistant", content: reply });
    return reply;
  } catch (err) {
    console.error("Groq Error:", err);
    return "Sorry, AI is unreachable.";
  }
};

// ---- Routes ----
app.get("/", async (req, res) => {
  const page = await getAnyPage();
  const wa = await getWhatsapp();
  res.render("index", { page, wa });
});

// FB OAuth
app.get("/connect", (req, res) => {
  const url =
    `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?` +
    new URLSearchParams({
      client_id: FB_APP_ID,
      redirect_uri: FB_REDIRECT_URI,
      scope: "pages_show_list,pages_messaging,business_management",
      response_type: "code",
    });
  res.redirect(url);
});

// FB Callback
app.get("/facebook/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code");

  const tokenResp = await axios.get(
    `https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`,
    { params: { client_id: FB_APP_ID, redirect_uri: FB_REDIRECT_URI, client_secret: FB_APP_SECRET, code } }
  );

  const userToken = tokenResp.data.access_token;
  const pagesResp = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/me/accounts`, { params: { access_token: userToken } });
  const pages = pagesResp.data.data;
  if (pages.length > 0) {
    savePage(pages[0].id, pages[0].name, pages[0].access_token);
  }
  res.redirect("/");
});

// Save WA creds
app.post("/save_whatsapp", (req, res) => {
  const { phone_id, token, display } = req.body;
  if (!phone_id || !token) return res.status(400).send("Missing WA credentials");
  saveWhatsapp(phone_id, token, display);
  res.redirect("/");
});

// Webhook (FB Messenger + WhatsApp)
app.all("/webhook", async (req, res) => {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode && token === VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
  }

  const data = req.body;
  try {
    if (data.entry) {
      for (const entry of data.entry) {
        // Messenger messages
        if (entry.messaging) {
          for (const ev of entry.messaging) {
            if (ev.message && !ev.message.is_echo && ev.message.text) {
              const chat_id = ev.thread_id || entry.id;
              const text = ev.message.text;
              saveMessage("messenger", chat_id, ev.sender.id, text, "incoming");
              const page = await getAnyPage();
              if (page) {
                const reply = await generateAIReply(chat_id, text);
                await axios.post(`https://graph.facebook.com/${FB_API_VERSION}/me/messages`, {
                  recipient: { id: ev.sender.id },
                  message: { text: reply },
                }, { params: { access_token: page.page_access_token } });
                saveMessage("messenger", chat_id, "page", reply, "outgoing");
              }
            }
          }
        }

        // WhatsApp messages
        if (entry.changes) {
          for (const change of entry.changes) {
            const val = change.value;
            if (val.messages) {
              for (const m of val.messages) {
                const txt = m.text?.body;
                const from = m.from;
                const chat_id = val.metadata.phone_number_id;
                if (txt) {
                  saveMessage("whatsapp", chat_id, from, txt, "incoming");
                  const wa = await getWhatsapp();
                  if (wa) {
                    const reply = await generateAIReply(chat_id, txt);
                    await axios.post(
                      `https://graph.facebook.com/${FB_API_VERSION}/${wa.phone_number_id}/messages`,
                      { messaging_product: "whatsapp", to: from, type: "text", text: { body: reply } },
                      { headers: { Authorization: `Bearer ${wa.token}` } }
                    );
                    saveMessage("whatsapp", chat_id, "wa_bot", reply, "outgoing");
                  }
                }
              }
            }
          }
        }
      }
    }
    res.send("EVENT_RECEIVED");
  } catch (err) {
    console.error("Webhook error:", err, data);
    res.sendStatus(500);
  }
});

// Socket.io for dashboard real-time
io.on("connection", (socket) => {
  console.log("Client connected");
  socket.on("send_message", async ({ chat_id, text, platform }) => {
    const reply = await generateAIReply(chat_id, text);
    io.emit("chat", { chat_id, text, reply, platform });
  });
  socket.on("disconnect", () => console.log("Client disconnected"));
});

// Dashboard API
app.get("/messages", (req, res) => {
  db.all(`SELECT * FROM messages ORDER BY id DESC LIMIT 200`, [], (err, rows) => {
    if (err) return res.status(500).send(err);
    res.json(rows.reverse());
  });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
