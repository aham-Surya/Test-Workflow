require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3');
const axios = require('axios');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- ENV ---
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const BASE_URL = process.env.BASE_URL;
const FB_API_VERSION = 'v19.0';

// --- DB ---
const db = new sqlite3.Database(path.join(__dirname, 'data', 'data.sqlite'));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS pages (id INTEGER PRIMARY KEY, page_id TEXT UNIQUE, page_name TEXT, page_token TEXT, subscribed INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE IF NOT EXISTS whatsapp (id INTEGER PRIMARY KEY, phone_number_id TEXT UNIQUE, token TEXT)`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, platform TEXT, chat_id TEXT, sender_id TEXT, text TEXT, direction TEXT, timestamp INTEGER)`);
});

// --- Helpers ---
function dbInsertMessage(platform, chat_id, sender_id, text, direction) {
  db.run(`INSERT INTO messages (platform, chat_id, sender_id, text, direction, timestamp) VALUES (?, ?, ?, ?, ?, ?)`,
    [platform, chat_id, sender_id, text, direction, Date.now()]);
}

function getAnyPage(callback) {
  db.get("SELECT * FROM pages LIMIT 1", [], (err, row) => callback(err, row));
}

function getWhatsapp(callback) {
  db.get("SELECT * FROM whatsapp LIMIT 1", [], (err, row) => callback(err, row));
}

// --- Groq AI call ---
async function generateReply(text) {
  try {
    const res = await axios.post('https://api.groq.com/v1/chat/completions', {
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: "You are a concise helpful assistant." },
        { role: "user", content: text }
      ]
    }, {
      headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` }
    });
    return res.data.choices[0].message.content;
  } catch (err) {
    console.error('Groq AI error:', err.response?.data || err.message);
    return "Sorry, AI is unreachable.";
  }
}

// --- Routes ---
app.get('/', (req, res) => {
  getAnyPage((err, page) => {
    getWhatsapp((err2, wa) => res.render('index', { page, wa }));
  });
});

// Facebook OAuth connect
app.get('/connect', (req, res) => {
  const url = `https://www.facebook.com/${FB_API_VERSION}/dialog/oauth?client_id=${FB_APP_ID}&redirect_uri=${BASE_URL}/facebook/callback&scope=pages_show_list,pages_messaging,business_management&response_type=code`;
  res.redirect(url);
});

// Facebook OAuth callback
app.get('/facebook/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code returned");
  try {
    // Get user token
    let { data } = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/oauth/access_token`, {
      params: { client_id: FB_APP_ID, redirect_uri: `${BASE_URL}/facebook/callback`, client_secret: FB_APP_SECRET, code }
    });
    const userToken = data.access_token;

    // Get pages
    const pagesRes = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/me/accounts`, { params: { access_token: userToken }});
    if (pagesRes.data.data.length > 0) {
      const first = pagesRes.data.data[0];
      db.run(`INSERT OR REPLACE INTO pages (page_id, page_name, page_token, subscribed) VALUES (?, ?, ?, 1)`,
        [first.id, first.name, first.access_token]);
      // Subscribe webhook
      try {
        await axios.post(`https://graph.facebook.com/${FB_API_VERSION}/${first.id}/subscribed_apps`,
          { subscribed_fields: "messages,messaging_postbacks" },
          { params: { access_token: first.access_token }});
      } catch (err) { console.error("Webhook subscribe error:", err.response?.data || err.message); }
    }
    res.redirect('/');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("OAuth failed");
  }
});

// Save WhatsApp credentials manually once
app.post('/save_whatsapp', (req, res) => {
  const { phone_id, token } = req.body;
  if (!phone_id || !token) return res.status(400).send("Missing phone_id or token");
  db.run(`INSERT OR REPLACE INTO whatsapp (phone_number_id, token) VALUES (?, ?)`, [phone_id, token], () => res.redirect('/'));
});

// Webhook (Messenger + WhatsApp)
app.all('/webhook', async (req, res) => {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'], token = req.query['hub.verify_token'], challenge = req.query['hub.challenge'];
    if (mode && token === VERIFY_TOKEN) return res.send(challenge);
    return res.status(403).send("Verification failed");
  }

  const data = req.body;
  try {
    // Messenger
    if (data.entry) {
      for (let entry of data.entry) {
        if (entry.messaging) {
          for (let ev of entry.messaging) {
            if (ev.message && !ev.message.is_echo) {
              const senderId = ev.sender.id;
              const text = ev.message.text;
              if (text) {
                dbInsertMessage("messenger", entry.id, senderId, text, "incoming");
                const reply = await generateReply(text);
                getAnyPage((err, page) => {
                  if (page) axios.post(`https://graph.facebook.com/${FB_API_VERSION}/me/messages`, {
                    recipient: { id: senderId },
                    message: { text: reply }
                  }, { params: { access_token: page.page_token }});
                  dbInsertMessage("messenger", entry.id, "page", reply, "outgoing");
                });
              }
            }
          }
        }
        // WhatsApp
        if (entry.changes) {
          for (let change of entry.changes) {
            const msgs = change.value?.messages || [];
            for (let m of msgs) {
              const from = m.from, text = m.text?.body;
              if (text) {
                dbInsertMessage("whatsapp", change.value.metadata.phone_number_id, from, text, "incoming");
                const reply = await generateReply(text);
                getWhatsapp((err, wa) => {
                  if (wa) axios.post(`https://graph.facebook.com/${FB_API_VERSION}/${wa.phone_number_id}/messages`, {
                    messaging_product: "whatsapp",
                    to: from,
                    type: "text",
                    text: { body: reply }
                  }, { headers: { Authorization: `Bearer ${wa.token}` }});
                  dbInsertMessage("whatsapp", wa.phone_number_id, "wa_bot", reply, "outgoing");
                });
              }
            }
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).send("Webhook error");
  }
});

// Messages endpoint
app.get('/messages', (req, res) => {
  db.all("SELECT * FROM messages ORDER BY id DESC LIMIT 200", [], (err, rows) => res.json(rows.reverse()));
});

// Manual send
app.post('/send_message', (req, res) => {
  const { platform, chat_id, message } = req.body;
  if (!message) return res.status(400).send("Message missing");
  if (platform === 'messenger') {
    getAnyPage((err, page) => {
      if (!page) return res.status(400).send("No page connected");
      axios.post(`https://graph.facebook.com/${FB_API_VERSION}/me/messages`,
        { recipient: { id: chat_id }, message: { text: message } },
        { params: { access_token: page.page_token }});
      dbInsertMessage("messenger", chat_id, "page", message, "outgoing");
      res.send("Sent");
    });
  } else if (platform === 'whatsapp') {
    getWhatsapp((err, wa) => {
      if (!wa) return res.status(400).send("No WA configured");
      axios.post(`https://graph.facebook.com/${FB_API_VERSION}/${wa.phone_number_id}/messages`,
        { messaging_product: "whatsapp", to: chat_id, type: "text", text: { body: message } },
        { headers: { Authorization: `Bearer ${wa.token}` }});
      dbInsertMessage("whatsapp", wa.phone_number_id, "wa_bot", message, "outgoing");
      res.send("Sent");
    });
  } else res.status(400).send("Unknown platform");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Meta Chatbot running!"));
