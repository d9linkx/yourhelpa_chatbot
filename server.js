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
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL; // Google Apps Script backend
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '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';

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID || !APPS_SCRIPT_URL) {
    console.error("❌ Critical environment variables missing. Exiting.");
    process.exit(1);
}

// =========================================================================
// PERSONA CONFIGURATION
// =========================================================================
const PERSONAS = {
    BUKKY: {
        name: "Bukky",
        tone: "super friendly, enthusiastic, and uses clear, informal language. She's your helpful marketplace buddy."
    },
    KORE: {
        name: "Kore",
        tone: "calm, cool, concise guidance with an informal vibe. Efficient but casual."
    }
};

// =========================================================================
// MENU OPTIONS CONFIGURATION
// =========================================================================
const MENU_OPTIONS = {
    OPT_FIND_SERVICE: { type: 'SERVICE', prompt: "Nice! Let's get you the right service provider. First, confirm the location where you need the help." },
    OPT_BUY_ITEM: { type: 'ITEM', prompt: "Got you! I’ll help you find the item. Before I search, can you confirm the location you need it delivered or inspected?" },
    OPT_MY_ACTIVE: { type: 'INFO', prompt: "This is where you can view your ongoing transactions. Feature coming soon!" },
    OPT_REPORT_ISSUE: { type: 'INFO', prompt: "Reporting an issue is easy. Feature coming soon!" },
    OPT_REGISTER_ME: { type: 'INFO', prompt: "You can become a provider here. Feature coming soon!" },
    OPT_SUPPORT: { type: 'INFO', prompt: "Support/help center. Feature coming soon!" },
    OPT_CHANGE_PERSONA: { type: 'INFO', prompt: "Switching persona. Feature coming soon!" }
};

// =========================================================================
// UTILITY FUNCTIONS
// =========================================================================
async function getUserState(phone) {
    try {
        const res = await axios.post(APPS_SCRIPT_URL, { action: 'GET_STATE', phone });
        if (res.data.success && res.data.user) {
            const user = res.data.user;
            user.preferred_persona ||= 'bukky';
            user.city_initial ||= 'Ibadan';
            user.state_initial ||= 'Oyo';
            user.current_flow ||= 'NEW';
            return user;
        }
        throw new Error('Apps Script returned unsuccessful response');
    } catch (err) {
        console.error("Apps Script GET_STATE error:", err.message);
        return {
            phone,
            user_id: `NEW-${Date.now()}`,
            role: 'unassigned',
            name: '',
            city: 'Ibadan',
            state_initial: 'Oyo',
            current_flow: 'NEW',
            preferred_persona: 'bukky',
            row_index: 0,
            selected_option: '',
            city_initial: 'Ibadan',
        };
    }
}

async function saveUser(user) {
    try {
        const res = await axios.post(APPS_SCRIPT_URL, { action: 'SAVE_STATE', user });
        if (!res.data.success) console.error("Apps Script SAVE_STATE failure:", res.data);
    } catch (err) {
        console.error("Apps Script SAVE_STATE error:", err.message);
    }
}

// =========================================================================
// OPENROUTER AI FUNCTION
// =========================================================================
async function openRouterGenerate(prompt, persona = 'bukky') {
    try {
        const systemPrompt = `You are ${PERSONAS[persona.toUpperCase()]?.name || 'Bukky'}, ${PERSONAS[persona.toUpperCase()]?.tone}. Keep replies informal, brief, and action-oriented.`;
        const res = await axios.post('https://api.openrouter.ai/v1/chat/completions', {
            model: 'openrouter-gpt-3.5-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ],
            max_tokens: 250
        }, {
            headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}` }
        });
        return res.data?.choices?.[0]?.message?.content || prompt;
    } catch (err) {
        console.error("OpenRouter error:", err.message);
        return "⚠️ AI is temporarily unavailable. Please try again.";
    }
}

// =========================================================================
// WHATSAPP MESSAGING FUNCTIONS
// =========================================================================
const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

async function sendWhatsAppMessage(to, payload) {
    try {
        await axios.post(META_API_URL, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload }, {
            headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' }
        });
    } catch (err) {
        console.error("WhatsApp send error:", err.response?.data || err.message);
    }
}

async function sendTextMessage(to, text) {
    if (!text) return;
    await sendWhatsAppMessage(to, { type: 'text', text: { body: text } });
}

function getConfirmationButtons(bodyText, yesId, noId, footerText = '', persona = 'bukky') {
    return {
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: bodyText },
            action: {
                buttons: [
                    { type: "reply", reply: { id: yesId, title: "✅ YES, Confirm" } },
                    { type: "reply", reply: { id: noId, title: `❌ NO, Start Over` } }
                ]
            },
            footer: { text: footerText || `Chatting with ${PERSONAS[persona.toUpperCase()]?.name || 'Bukky'}` }
        }
    };
}

// =========================================================================
// MAIN MENU
// =========================================================================
async function sendMainMenu(senderId, user, senderName, isFirstTime = false) {
    const persona = PERSONAS[user.preferred_persona.toUpperCase()] || PERSONAS.BUKKY;

    let bodyText = isFirstTime
        ? `Hey *${senderName}*! I'm ${persona.name}, your plug for buying, selling, and hiring services in Lagos and Oyo State. What's the plan?`
        : `I'm ready when you are, *${senderName}*! What's next?`;

    const listRows = [
        { id: "OPT_FIND_SERVICE", title: "🛠️ Request a Service" },
        { id: "OPT_BUY_ITEM", title: "🛍️ Find an Item" },
        { id: "OPT_MY_ACTIVE", title: "💼 Ongoing Transactions" },
        { id: "OPT_REPORT_ISSUE", title: "🚨 Report an Issue" }
    ];

    if (user.role === 'unassigned') listRows.push({ id: "OPT_REGISTER_ME", title: "🌟 Become a Provider" });

    const listSections = [{
        title: "Quick Actions",
        rows: listRows.map(r => ({ id: r.id, title: r.title }))
    }, {
        title: "Settings",
        rows: [
            { id: "OPT_SUPPORT", title: "⚙️ Support/Help" },
            { id: "OPT_CHANGE_PERSONA", title: `🔄 Switch Persona` }
        ]
    }];

    const menuPayload = {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: `${persona.name}'s Main Menu` },
            body: { text: bodyText },
            action: { button: "View Options", sections: listSections },
            footer: { text: "Use the list below for quick access!" }
        }
    };

    await sendWhatsAppMessage(senderId, menuPayload);
}

// =========================================================================
// MESSAGE ROUTER
// =========================================================================
async function handleMessageFlow(senderId, senderName, message) {
    try {
        const user = await getUserState(senderId);

        const interactiveId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        const textInput = message.text?.body?.trim();
        const flowInput = interactiveId || textInput;

        // NEW USER / MENU
        if (user.current_flow === 'NEW' || flowInput?.toUpperCase() === 'MENU') {
            user.current_flow = 'MAIN_MENU';
            await saveUser(user);
            await sendMainMenu(senderId, user, senderName, true);
            return;
        }

        // MAIN MENU SELECTION
        if (user.current_flow === 'MAIN_MENU' && interactiveId) {
            const option = MENU_OPTIONS[interactiveId];
            if (!option) {
                await sendTextMessage(senderId, "I didn't understand that selection. Please choose from the menu.");
                return;
            }

            user.selected_option = interactiveId;
            if (option.type === 'SERVICE') user.current_flow = 'AWAIT_SERVICE_LOCATION_CONFIRM';
            if (option.type === 'ITEM') user.current_flow = 'AWAIT_ITEM_LOCATION_CONFIRM';
            await saveUser(user);

            const aiText = await openRouterGenerate(option.prompt, user.preferred_persona);
            await sendWhatsAppMessage(senderId, getConfirmationButtons(
                aiText,
                "CONFIRM_LOCATION",
                "CORRECT_LOCATION",
                `Current location: ${user.city || user.city_initial}, ${user.state_initial}`,
                user.preferred_persona
            ));
            return;
        }

        // CONFIRMATION FLOWS (location etc.)
        if (user.current_flow.startsWith('AWAIT_')) {
            await sendTextMessage(senderId, "Great! We'll proceed with this option.");
            user.current_flow = 'MAIN_MENU';
            await saveUser(user);
            await sendMainMenu(senderId, user, senderName, false);
            return;
        }

        // FALLBACK
        await sendTextMessage(senderId, "I didn't understand that. Please select an option from the menu.");

    } catch (err) {
        console.error("handleMessageFlow error:", err.message);
        await sendTextMessage(senderId, "Oops! Something went wrong. Type MENU to restart.");
    }
}

// =========================================================================
// EXPRESS SERVER
// =========================================================================
app.use(bodyParser.json());

// WEBHOOK VERIFICATION
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) res.status(200).send(challenge);
    else res.sendStatus(403);
});

// MESSAGE HANDLING
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
                        console.log(`New message from ${senderName}: ${message.text?.body || message.interactive?.list_reply?.title || message.interactive?.button_reply?.title || ''}`);
                        handleMessageFlow(senderId, senderName, message);
                    }
                }
            });
        });
    }

    res.sendStatus(200);
});

// START SERVER
app.listen(PORT, () => {
    console.log(`YourHelpa Server listening on port ${PORT}`);
});
