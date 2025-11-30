// --- REQUIRED MODULES ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();

// =========================================================================
// !!! CRITICAL CONFIGURATION DETAILS !!!
// =========================================================================

const PORT = process.env.PORT || 5000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN; 
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; 

// --- GOOGLE APPS SCRIPT CONFIGURATION (MANDATORY ENV VARIABLE) ---
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // MUST be set in environment variables

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("❌ CRITICAL ERROR: WhatsApp environment variables (VERIFY_TOKEN, ACCESS_TOKEN, PHONE_NUMBER_ID) are missing.");
    process.exit(1); 
}

if (!APPS_SCRIPT_URL) {
    console.error("❌ CRITICAL ERROR: APPS_SCRIPT_URL environment variable is missing.");
    console.error("Exiting due to missing critical environment variable.");
    process.exit(1);
}


// =========================================================================
// GOOGLE APPS SCRIPT & USER STATE MANAGEMENT (KEPT FOR BACKEND INTEGRATION)
// =========================================================================

/**
 * Retrieves the user's state from the Apps Script backend.
 */
async function getUserState(phone) {
    try {
        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'GET_STATE',
            phone: phone
        });
        
        if (typeof response.data === 'string' && response.data.startsWith('<!DOCTYPE html>')) {
             throw new Error("Apps Script returned an HTML error.");
        }
        
        if (response.data.success && response.data.user) {
            // Initialize defaults if missing
            const user = response.data.user;
            if (!user.preferred_persona) user.preferred_persona = 'bukky'; 
            if (!user.city_initial) user.city_initial = 'Ibadan';
            if (!user.state_initial) user.state_initial = 'Oyo';
            if (!user.current_flow) user.current_flow = 'NEW';
            
            return user;
        } else {
            throw new Error("Apps Script returned an unsuccessful response.");
        }

    } catch (e) {
        console.error("❌ APPS SCRIPT COMMUNICATION ERROR (GET_STATE):", e.message);
        // Default user object for new/error state
        return { 
            phone: phone, 
            user_id: `ERROR-${Date.now()}`,
            role: 'unassigned', 
            name: '',
            city: 'Ibadan', 
            state_initial: 'Oyo',
            current_flow: 'NEW',
            preferred_persona: 'bukky',
            row_index: 0,
            service_category: '', 
            description_summary: '', 
            city_initial: 'Ibadan', 
            budget_initial: '', 
            item_name: '', 
            item_description: '',
        };
    }
}

/**
 * Saves the user's state to the Apps Script backend.
 */
async function saveUser(user) {
    try {
        user.item_name = user.service_category;
        user.item_description = user.description_summary;

        const response = await axios.post(APPS_SCRIPT_URL, {
            action: 'SAVE_STATE',
            user: user
        });
        
        if (typeof response.data === 'string' && response.data.startsWith('<!DOCTYPE html>')) {
            console.error("🚨 APPS SCRIPT FAILURE (SAVE_STATE): Received HTML error page. State NOT saved.");
            return;
        }
        
        if (response.data.success) {
            console.log(`✅ User ${user.phone} state updated to: ${user.current_flow}`);
        } else {
            console.error("🚨 APPS SCRIPT FAILURE (SAVE_STATE): Unsuccessful or malformed response. State NOT saved.", response.data.error || response.data);
        }
        
    } catch (e) {
        console.error("❌ APPS SCRIPT COMMUNICATION ERROR (SAVE_STATE):", e.message);
    }
}


// =========================================================================
// WHATSAPP MESSAGING FUNCTIONS (Minimal, for basic text replies)
// =========================================================================

const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

async function sendWhatsAppMessage(to, messagePayload) {
    try {
        const finalPayload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to,
            ...messagePayload
        };

        await axios.post(META_API_URL, finalPayload, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        const type = messagePayload.type || 'text';
        console.log(`[Response Sent] To: ${to} | Type: ${type}`);
    } catch (error) {
        console.error("❌ Error sending message to WhatsApp:", error.response?.data || error.message);
    }
}

async function sendTextMessage(to, text) {
    if (!text) return;
    await sendWhatsAppMessage(to, {
        type: "text",
        text: { body: text }
    });
}


// =========================================================================
// MAIN MESSAGE ROUTER (REMOVED LOGIC)
// =========================================================================

/**
 * Main function to handle the user's message. All conversational logic is removed.
 */
async function handleMessageFlow(senderId, senderName, message) {
    // Log the incoming message for debugging
    let logText = message.text?.body || 'Interactive Click/Non-text message';
    
    console.log(`\n--- YourHelpa: MESSAGE RECEIVED ---`);
    console.log(`From: ${senderName} (${senderId})`);
    console.log(`Input: ${logText}`);
    console.log("NOTE: All chatbot flow logic has been removed from this function.");

    // Send a generic, non-conversational acknowledgement
    await sendTextMessage(senderId, `Thank you for your message. The chatbot functionality is currently disabled, but the webhook is receiving messages successfully.`);
}


// =========================================================================
// EXPRESS SERVER SETUP 
// =========================================================================

app.use(bodyParser.json());

// --- 1. WEBHOOK VERIFICATION (GET request) ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ WEBHOOK VERIFIED successfully!');
        res.status(200).send(challenge);
    } else {
        console.error('❌ Webhook verification failed!');
        res.sendStatus(403);
    }
});

// --- 2. MESSAGE HANDLING (POST request) ---
app.post('/webhook', (req, res) => {
    const data = req.body;

    if (data.object === 'whatsapp_business_account') {
        data.entry.forEach(entry => {
            entry.changes.forEach(change => {
                if (change.field === 'messages' && change.value.messages) {
                    const message = change.value.messages[0];
                    const senderId = change.value.contacts[0].wa_id;
                    const senderName = change.value.contacts[0].profile.name;
                    
                    if (message.type === 'text' || message.type === 'interactive') {
                        // All complex flow logic happens in the dedicated function
                        handleMessageFlow(senderId, senderName, message);
                    }
                }
            });
        });
    }
    // ALWAYS respond with a 200 OK to Meta
    res.sendStatus(200);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`\nYourHelpa Server is listening on port ${PORT}`);
    console.log("✅ Chatbot logic is now running in a flow-free, logging-only configuration.");
});