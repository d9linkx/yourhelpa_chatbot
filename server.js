// --- REQUIRED MODULES ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios'); // Used to make API calls to Meta

const app = express();

// =========================================================================
// !!! CRITICAL CONFIGURATION DETAILS - READ FROM ENVIRONMENT VARIABLES !!!
// =========================================================================

// PORT is read from the environment (Render requires this)
const PORT = process.env.PORT || 5000;

// These sensitive values are read from the environment variables 
// you must set in the Render dashboard for security.
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Construct the base URL for sending messages
const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

// Check for missing environment variables before starting
if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("CRITICAL ERROR: One or more required environment variables are missing.");
    console.error("Please ensure VERIFY_TOKEN, ACCESS_TOKEN, and PHONE_NUMBER_ID are set correctly in your Render dashboard.");
    // Exit the process since we cannot connect to the Meta API without these
    process.exit(1); 
}
// =========================================================================

// Use body-parser to parse application/json
app.use(bodyParser.json());

// --- FUNCTION TO SEND MESSAGES ---
// This function constructs and sends a text message reply using the Meta API
async function sendMessage(to, text) {
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
                // IMPORTANT: Using the secure ACCESS_TOKEN from the environment
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
        // Respond with the challenge token to complete the handshake
        res.status(200).send(challenge);
    } else {
        console.error('Webhook verification failed! Tokens do not match.');
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

                    // Call the send message function
                    sendMessage(senderId, replyText);

                    console.log('------------------------------\n');
                }
            });
        });
    }
    // ALWAYS respond with a 200 OK to Meta within 20 seconds
    res.sendStatus(200);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`\nServer is listening on port ${PORT}`);
    // Your verified Render URL: https://yourhelpa-chatbot.onrender.com/webhook
    console.log(`Deployment Ready! Webhook URL: https://yourhelpa-chatbot.onrender.com/webhook`);
});