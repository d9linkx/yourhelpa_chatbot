// --- REQUIRED MODULES ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios'); // Used to make API calls to Meta

const app = express();
const PORT = 5000;

// =========================================================================
// !!! CRITICAL CONFIGURATION DETAILS (GET FROM META API SETUP PAGE) !!!
// =========================================================================
const VERIFY_TOKEN = 'MY_CHATBOT_SECRET_TOKEN_12031993'; // Your current verify token (must match Meta dashboard)
const ACCESS_TOKEN = 'EAAQxSymgxKQBP0TLqPDPV2Gw8qjW6zvWZBOQEfm4RYodjoyUMgV5w2TKG3Jd0zLX75CMZBEYd7ract5ZCdtiKOelHMr2duyAHau8fOSLuziy1IdHydS0Trj7LeFDLmnEe7FPD2qwPIeLI5PZArGgrslvmZAMOxVH1kLZC9TJofYWwNqgECcdjmJmMhQgz6RUZBQCw9GZBXlkvwqSlBoXaQjvtsa9ZCa9gQjrTsHQoWysRIGCjeQQELX9LZAvyPMe32zrgOKMVjtbbIIbJoJwUmvPcF8pk4ldPQ9Yt4XSQZD';      // <<< REPLACE with the long Access Token
const PHONE_NUMBER_ID = '1180098797552804';      // <<< REPLACE with the Phone Number ID (e.g., 7693xxxxxx)

// Construct the base URL for sending messages
const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;
// =========================================================================

// Use body-parser to parse application/json
app.use(bodyParser.json());

// --- FUNCTION TO SEND MESSAGES ---
// This function constructs and sends a text message reply using the Meta API
async function sendMessage(to, text) {
    if (ACCESS_TOKEN === 'YOUR_GENERATED_ACCESS_TOKEN') {
        console.error("ERROR: ACCESS_TOKEN not set. Cannot send reply.");
        return;
    }
    try {
        await axios.post(META_API_URL, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to, // The user's phone number (WA_ID)
            type: "text",
            text: {
                body: text
            }
        }, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[Response Sent] To: ${to} | Text: ${text}`);
    } catch (error) {
        // Log the full Meta error response if available for debugging
        console.error("Error sending message:", error.response?.data || error.message);
    }
}

// --- 1. WEBHOOK VERIFICATION (GET request) ---
// This endpoint handles the initial Meta handshake.
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WEBHOOK VERIFIED successfully!');
        res.status(200).send(challenge);
    } else {
        console.error('Webhook verification failed!');
        res.sendStatus(403);
    }
});

// --- 2. MESSAGE HANDLING (POST request) ---
// This endpoint receives messages and status updates from Meta.
app.post('/webhook', (req, res) => {
    const data = req.body;

    if (data.object === 'whatsapp_business_account') {
        data.entry.forEach(entry => {
            entry.changes.forEach(change => {
                if (change.field === 'messages' && change.value.messages) {
                    const message = change.value.messages[0];
                    const senderId = change.value.contacts[0].wa_id;
                    const senderName = change.value.contacts[0].profile.name;
                    const incomingText = message.text?.body || '';

                    console.log(`\n--- NEW MESSAGE RECEIVED ---`);
                    console.log(`From: ${senderName} (${senderId})`);
                    console.log(`Text: ${incomingText}`);

                    // === CHATBOT LOGIC: Echo the message back to the sender ===
                    const replyText = `Hello ${senderName}! You sent: "${incomingText}". The server is running and attempting to reply!`;

                    // Call the new send message function
                    sendMessage(senderId, replyText);

                    console.log('------------------------------\n');
                }
            });
        });
    }
    // ALWAYS respond with a 200 OK to Meta
    res.sendStatus(200);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`\nServer is listening on port ${PORT}`);
    console.log(`Local Webhook URL: http://localhost:${PORT}/webhook`);
    // NOTE: Update this placeholder with your current NGROK URL
    console.log(`NGROK Public URL: PASTE_YOUR_NGROK_URL_HERE/webhook`);
});