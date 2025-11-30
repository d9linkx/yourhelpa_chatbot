// --- REQUIRED MODULES ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();

// =========================================================================
// CONFIGURATION
// =========================================================================
const PORT = process.env.PORT || 5000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN; 
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; 
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; 
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "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";

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID || !APPS_SCRIPT_URL) {
    console.error("❌ Missing critical environment variables.");
    process.exit(1);
}

// =========================================================================
// PERSONAS
// =========================================================================
const PERSONAS = {
    BUKKY: { name: "Bukky", tone: "friendly, casual, and helpful" },
    KORE: { name: "Kore", tone: "calm, concise, casual" }
};

// =========================================================================
// OPENROUTER AI FUNCTION
// =========================================================================
async function chatWithAI(user, userInput) {
    const persona = PERSONAS[user.preferred_persona?.toUpperCase()] || PERSONAS.BUKKY;

    // System prompt defines the AI behavior
    const systemPrompt = `
You are ${persona.name}, a friendly WhatsApp assistant helping users in Lagos and Oyo State.
Your tone is: ${persona.tone}.
Use short, conversational sentences.
Always guide the user to the next step in the process.
Keep the flow aligned with the user's current state: ${user.current_flow}.
Respond in informal English; avoid long paragraphs.
    `;

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userInput }
    ];

    try {
        const response = await axios.post(
            "https://api.openrouter.ai/v1/chat/completions",
            {
                model: "orca-mini-3b",
                messages,
                temperature: 0.7
            },
            { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` } }
        );
        return response.data.choices[0].message.content;
    } catch (e) {
        console.error("AI Error:", e.message);
        return "Sorry, I’m having trouble right now. Please try again.";
    }
}

// =========================================================================
// APPS SCRIPT USER STATE
// =========================================================================
async function getUserState(phone) {
    try {
        const resp = await axios.post(APPS_SCRIPT_URL, { action: 'GET_STATE', phone });
        if (resp.data.success && resp.data.user) {
            const user = resp.data.user;
            return {
                ...user,
                preferred_persona: user.preferred_persona || 'bukky',
                current_flow: user.current_flow || 'NEW',
                role: user.role || 'unassigned'
            };
        }
    } catch (e) { console.error("GET_STATE Error:", e.message); }

    return {
        phone,
        user_id: `NEW-${Date.now()}`,
        preferred_persona: 'bukky',
        current_flow: 'NEW',
        role: 'unassigned'
    };
}

async function saveUser(user) {
    try {
        await axios.post(APPS_SCRIPT_URL, { action: 'SAVE_STATE', user });
    } catch (e) { console.error("SAVE_STATE Error:", e.message); }
}

// =========================================================================
// WHATSAPP SEND FUNCTIONS
// =========================================================================
const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

async function sendWhatsAppMessage(to, payload) {
    try {
        await axios.post(META_API_URL, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            ...payload
        }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (e) { console.error("WhatsApp Send Error:", e.response?.data || e.message); }
}

async function sendText(to, text) {
    if (!text) return;
    await sendWhatsAppMessage(to, { type: "text", text: { body: text } });
}

// =========================================================================
// MAIN MESSAGE HANDLER
// =========================================================================
async function handleMessageFlow(senderId, senderName, message) {
    const user = await getUserState(senderId);

    // Extract text or interactive button/list selection
    const interactiveId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || '';
    const textInput = message.text?.body?.trim();
    const input = interactiveId || textInput;

    console.log(`[Flow] User: ${senderName} | Input: ${input} | Flow: ${user.current_flow}`);

    let userMessage = input;

    // --- NEW USER: send greeting via AI ---
    if (user.current_flow === 'NEW') {
        userMessage = `Greet the user ${senderName} and offer the main menu options: Request Service, Find Item, Ongoing Transactions, Report Issue, Become a Provider, Support, Switch Persona.`;
        user.current_flow = 'MAIN_MENU';
    }

    // --- MAIN MENU SELECTION ---
    if (user.current_flow === 'MAIN_MENU') {
        if (input.startsWith("OPT_")) {
            switch(input) {
                case "OPT_FIND_SERVICE":
                    user.current_flow = 'AWAIT_SERVICE_LOCATION';
                    userMessage = "Great! Ask the user where they need the service.";
                    break;
                case "OPT_BUY_ITEM":
                    user.current_flow = 'AWAIT_ITEM_LOCATION';
                    userMessage = "Okay! Ask where the item should be delivered or inspected.";
                    break;
                default:
                    userMessage = `You selected ${input.replace('OPT_','')}. Respond acknowledging this action.`;
                    break;
            }
        } else {
            userMessage = "Please select an option from the menu.";
        }
    }

    // --- AWAITING LOCATION ---
    if (user.current_flow === 'AWAIT_SERVICE_LOCATION' || user.current_flow === 'AWAIT_ITEM_LOCATION') {
        userMessage = `User said: "${input}". Guide them to the next step and ask for details about the service or item.`;
        user.current_flow = (user.current_flow === 'AWAIT_SERVICE_LOCATION') ? 'SERVICE_REQUEST_DETAILS' : 'ITEM_REQUEST_DETAILS';
    }

    // --- SERVICE / ITEM DETAILS ---
    if (user.current_flow === 'SERVICE_REQUEST_DETAILS' || user.current_flow === 'ITEM_REQUEST_DETAILS') {
        userMessage = `User provided: "${input}". Confirm receipt and ask if they want to submit or modify any details.`;
    }

    // Generate AI response
    const aiResponse = await chatWithAI(user, userMessage);

    // Save updated state
    await saveUser(user);

    // Send AI response to WhatsApp
    await sendText(senderId, aiResponse);
}

// =========================================================================
// EXPRESS SERVER
// =========================================================================
app.use(bodyParser.json());

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ Webhook Verified');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

app.post('/webhook', (req, res) => {
    const data = req.body;

    if (data.object === 'whatsapp_business_account') {
        data.entry.forEach(entry => {
            entry.changes.forEach(change => {
                if (change.field === 'messages' && change.value.messages) {
                    const message = change.value.messages[0];
                    const senderId = change.value.contacts[0].wa_id;
                    const senderName = change.value.contacts[0].profile?.name || "User";

                    handleMessageFlow(senderId, senderName, message);
                }
            });
        });
    }

    res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
