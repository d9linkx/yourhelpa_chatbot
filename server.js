// --- REQUIRED MODULES ---
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios'); // Used to make API calls to Meta
const { initializeApp } = require('firebase/app');
const { getAuth, signInWithCustomToken, signInAnonymously } = require('firebase/auth');
const { getFirestore, doc, getDoc, setDoc } = require('firebase/firestore');

const app = express();

// =========================================================================
// !!! CRITICAL CONFIGURATION DETAILS - READ FROM ENVIRONMENT VARIABLES !!!
// =========================================================================

const PORT = process.env.PORT || 5000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Gemini API Configuration
// NOTE: This MUST be set in your Render environment variables to work!
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; 
const GEMINI_MODEL = 'gemini-2.5-flash-preview-09-2025';

// Global Firebase variables provided by the Canvas environment
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

if (!VERIFY_TOKEN || !ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.error("CRITICAL ERROR: WhatsApp environment variables are missing.");
    process.exit(1); 
}
if (!firebaseConfig) {
    console.error("CRITICAL ERROR: Firebase configuration (__firebase_config) is missing.");
    process.exit(1);
}

// Global Firebase instances (initialized later)
let db;
let auth;

// =========================================================================
// FIREBASE & USER STATE MANAGEMENT (Firestore acts as Google Sheets)
// =========================================================================

/**
 * Initializes Firebase, authenticates, and returns the current user ID.
 * @returns {string} The current user's UID or a generated ID.
 */
async function initializeFirebase() {
    try {
        if (!db) {
            const firebaseApp = initializeApp(firebaseConfig);
            db = getFirestore(firebaseApp);
            auth = getAuth(firebaseApp);
            
            // Authenticate using the provided token or anonymously
            if (initialAuthToken) {
                await signInWithCustomToken(auth, initialAuthToken);
            } else {
                await signInAnonymously(auth);
            }
        }
        return auth.currentUser?.uid || crypto.randomUUID();

    } catch (e) {
        console.error("Firebase initialization or authentication failed:", e);
        return null;
    }
}

/**
 * Gets the user's current state from Firestore or creates a new profile.
 * @param {string} phone The user's WhatsApp ID.
 * @returns {Promise<object>} The user document.
 */
async function getUserState(phone) {
    const userId = auth.currentUser.uid;
    // Data stored privately under the current authenticated user's ID
    const userDocRef = doc(db, `/artifacts/${appId}/users/${userId}/users`, phone);
    
    try {
        const docSnap = await getDoc(userDocRef);

        if (docSnap.exists()) {
            return docSnap.data();
        } else {
            // New User Onboarding (Section 1.2)
            const newUser = {
                user_id: `USER-${Date.now()}`,
                phone: phone,
                role: 'unassigned', // hire, helpa, seller
                name: '',
                city: '',
                created_at: new Date().toISOString(),
                status: 'NEW', // NEW -> ONBOARDING_ROLE_ASKED -> MAIN_MENU
                current_flow: 'onboarding',
            };
            await setDoc(userDocRef, newUser);
            return newUser;
        }
    } catch (e) {
        console.error("Error accessing user state in Firestore:", e);
        // Return a safe, basic object to prevent crashes
        return { status: 'ERROR', phone: phone, role: 'unassigned' };
    }
}

/**
 * Saves or updates the user profile in Firestore.
 * @param {object} user The user object to save.
 */
async function saveUser(user) {
    const userId = auth.currentUser.uid;
    const userDocRef = doc(db, `/artifacts/${appId}/users/${userId}/users`, user.phone);
    try {
        await setDoc(userDocRef, user, { merge: true });
        console.log(`User ${user.phone} state updated to ${user.status}`);
    } catch (e) {
        console.error("Error saving user state:", e);
    }
}

// =========================================================================
// GEMINI AI INTEGRATION (Section 13)
// =========================================================================

const SYSTEM_INSTRUCTION = `
You are YourHelpa, a WhatsApp-based conversational marketplace. Your primary goal is to facilitate simple and safe transactions between users.
Your persona is friendly, encouraging, highly reliable, and concise. You use emojis sparingly for clarity.
Your job is to guide the user through structured steps (onboarding, service request, registration) and interpret natural language messages.

Current Task: Act as the conversational router and onboarding guide.

Response Rules:
1. Always keep responses short and to the point.
2. When presenting options, use numbered lists or clear short sentences with the option in CAPITAL LETTERS if buttons are not available.
3. If the user is NEW, start the onboarding immediately.
4. If the user is at the MAIN_MENU, present the options based on their 'role'.
`;

/**
 * Calls the Gemini API to generate a conversational response.
 * @param {string} text The user's input text.
 * @param {string} systemPrompt The system instruction tailored to the current step.
 * @returns {Promise<string>} The generated text response.
 */
async function generateAIResponse(text, systemPrompt = SYSTEM_INSTRUCTION) {
    if (!GEMINI_API_KEY) {
        return "⚠️ AI Service Error: GEMINI_API_KEY is not configured on the server. Please add it to Render.";
    }
    
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
    
    const payload = {
        contents: [{ parts: [{ text: text }] }],
        systemInstruction: {
            parts: [{ text: systemPrompt }]
        },
    };

    try {
        const response = await axios.post(apiUrl, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        
        const result = response.data;
        const generatedText = result.candidates?.[0]?.content?.parts?.[0]?.text;
        
        return generatedText || "Sorry, I couldn't process that request right now. Please try again.";

    } catch (error) {
        console.error("Gemini API Error:", error.response?.data || error.message);
        return "I'm having trouble connecting to my brain. Please wait a moment and try sending your message again.";
    }
}

// =========================================================================
// WHATSAPP HELPER FUNCTIONS
// =========================================================================

const META_API_URL = `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`;

/**
 * Returns the Main Menu structure based on the user's role (Section 2).
 * @param {string} role The user's assigned role ('hire', 'helpa', 'seller', 'buyer', 'unassigned').
 * @returns {string} The formatted menu text.
 */
function getMainMenu(role) {
    // Role-specific options
    let options = [];
    if (role === 'hire' || role === 'unassigned') {
        options.push("1️⃣ Find a professional or service provider (Hire)");
    }
    if (role === 'hire' || role === 'unassigned') {
        options.push("2️⃣ Buy an item (Buyer)");
    }
    if (role === 'helpa' || role === 'unassigned') {
        options.push("3️⃣ Register as a Helpa (Offer Service)");
    }
    if (role === 'seller' || role === 'unassigned') {
        options.push("4️⃣ List items for sale (Seller)");
    }

    // Common options
    options.push("5️⃣ My Active Jobs or Purchases");
    options.push("6️⃣ Support");

    let menu = `✨ *Welcome to YourHelpa!* ✨\n\nYour current role is *${role.toUpperCase()}*. How can I help you today? Please reply with the number of your choice:\n\n`;
    menu += options.join('\n');
    
    return menu;
}


async function sendMessage(to, text) {
    // Uses the working Meta API configuration
    try {
        await axios.post(META_API_URL, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: to,
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
        console.log(`[Response Sent] To: ${to} | Text: ${text.substring(0, 50)}...`);
    } catch (error) {
        console.error("Error sending message:", error.response?.data || error.message);
    }
}

// =========================================================================
// MESSAGE ROUTER AND FLOW LOGIC (The core of the bot)
// =========================================================================

/**
 * Main function to handle the user's message and determine the next step.
 */
async function handleMessageFlow(senderId, senderName, incomingText) {
    const authId = await initializeFirebase();
    if (!authId) {
        return sendMessage(senderId, "System Error: Cannot connect to the database. Please contact support.");
    }
    
    let user = await getUserState(senderId);

    let replyText = '';

    // --- NEW USER ONBOARDING (Section 1.1) ---
    if (user.status === 'NEW' || user.status === 'ERROR') {
        const onboardingPrompt = `
        Hello ${senderName}, I'm YourHelpa! I'm here to help you hire, sell, or offer services safely.
        
        To get started, please tell me your primary goal by replying with the number of your choice:

        1️⃣ HIRE someone (find a professional or service)
        2️⃣ OFFER a service (become a Helpa)
        3️⃣ SELL items (list products for sale)
        
        (This choice determines your experience, but you can always access all features later!)
        `;
        user.status = 'ONBOARDING_ROLE_ASKED';
        await saveUser(user);
        replyText = onboardingPrompt;
    
    } 
    
    // --- PROCESSING ONBOARDING ROLE SELECTION ---
    else if (user.status === 'ONBOARDING_ROLE_ASKED') {
        const choice = incomingText.trim();
        let newRole = '';

        // Basic classification logic
        if (choice.includes('1') || choice.toLowerCase().includes('hire')) {
            newRole = 'hire';
        } else if (choice.includes('2') || choice.toLowerCase().includes('offer')) {
            newRole = 'helpa';
        } else if (choice.includes('3') || choice.toLowerCase().includes('sell')) {
            newRole = 'seller';
        } else {
            // Invalid input: re-ask the question
            replyText = "I didn't quite catch that. Please reply with *1*, *2*, or *3* to select your primary goal.";
            await sendMessage(senderId, replyText);
            return;
        }

        user.role = newRole;
        user.status = 'MAIN_MENU';
        await saveUser(user);

        // Use AI to generate a warm welcome based on their new role
        const aiPrompt = `The user selected the role: ${newRole}. Generate a single, concise, and friendly welcome message (max 3 sentences) that confirms their choice and immediately presents the Main Menu. Do not generate the menu itself.`;
        const welcomeMessage = await generateAIResponse(aiPrompt);
        
        // Send the welcome message, then the menu
        await sendMessage(senderId, welcomeMessage);
        
        replyText = getMainMenu(user.role);

    } 
    
    // --- MAIN MENU ROUTER ---
    else if (user.status === 'MAIN_MENU' || user.status === 'AWAITING_FLOW_START') {
        const choice = incomingText.trim();
        
        // Reset status if user is currently awaiting the start of a flow
        user.status = 'MAIN_MENU';
        
        // Simple command handling
        if (choice.toLowerCase() === 'menu' || choice.toLowerCase() === 'hi') {
             replyText = getMainMenu(user.role);
             await sendMessage(senderId, replyText);
             return;
        }

        // Route the user based on the selected number
        switch (choice) {
            case '1':
                // Section 3: Service Request Flow (Hiring Someone)
                user.current_flow = 'service_request';
                user.status = 'SERVICE_ASK_WHAT';
                await saveUser(user);
                replyText = await generateAIResponse("The user is starting the 'Find a professional or service provider' flow. Ask them 'What service do you need? (e.g., A plumber, a graphic designer, a tutor)' in a friendly, conversational tone.");
                break;
            case '2':
                // Section 4: Buyer Flow (Purchasing Items)
                user.current_flow = 'buyer_flow';
                user.status = 'BUYER_ASK_ITEM';
                await saveUser(user);
                replyText = await generateAIResponse("The user is starting the 'Buy an item' flow. Ask them 'What item are you looking to buy? (e.g., A used iPhone 12, a custom-made cake)' in a friendly, conversational tone.");
                break;
            case '3':
                // Section 5: Helpa Registration
                user.current_flow = 'helpa_registration';
                user.status = 'HELPA_ASK_NAME';
                await saveUser(user);
                replyText = await generateAIResponse("The user is starting the 'Helpa Registration' flow. Ask them for their full name and city to begin registration.");
                break;
            case '4':
                // Section 6: Seller Registration
                user.current_flow = 'seller_registration';
                user.status = 'SELLER_ASK_PRODUCT';
                await saveUser(user);
                replyText = await generateAIResponse("The user is starting the 'Seller Registration' flow. Ask them for the name and a short description of the first item they want to list.");
                break;
            case '5':
                // Section 8: Job Execution Tracking (Placeholder)
                replyText = "The *My Active Jobs* feature is under construction! Check back soon.";
                break;
            case '6':
                // Section 12: Support (Placeholder)
                replyText = await generateAIResponse("The user needs support. Acknowledge this and offer a way to contact a human admin using a mock email address: support@yourhelpa.com.");
                break;
            default:
                // If AI doesn't recognize the input, prompt for menu options
                isAIResponse = true;
                replyText = await generateAIResponse(`The user sent: "${incomingText}". They are at the Main Menu. They need to be guided back to choosing a numbered option from the menu.`);
                break;
        }
    } 
    
    // --- DEFAULT FALLBACK: AI handles conversation based on current context ---
    else {
        // Handle all subsequent conversation steps (e.g., asking for job details)
        // Future code will go here for SERVICE_ASK_WHAT, etc.
        
        // For now, if we're not in a specific flow step, fall back to the main menu
        replyText = getMainMenu(user.role);
    }
    
    // Send the final generated response
    await sendMessage(senderId, replyText);
}


// =========================================================================
// EXPRESS SERVER SETUP
// =========================================================================

// Use body-parser to parse application/json
app.use(bodyParser.json());

// --- 1. WEBHOOK VERIFICATION (GET request) ---
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

                    console.log(`\n--- YourHelpa: NEW MESSAGE RECEIVED ---`);
                    console.log(`From: ${senderName} (${senderId})`);
                    console.log(`Text: ${incomingText}`);

                    // ASYNC Call to the main logic flow
                    handleMessageFlow(senderId, senderName, incomingText);
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
    console.log(`Webhook URL: https://yourhelpa-chatbot.onrender.com/webhook`);
});