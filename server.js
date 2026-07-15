require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { PrismaClient } = require('@prisma/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const upload = multer({ storage: multer.memoryStorage() });

const chunkText = (text, chunkSize = 600, overlap = 100) => {
    const cleanText = text.replace(/\s+/g, ' ').trim();
    const chunks = [];
    let index = 0;
    while (index < cleanText.length) {
        const chunk = cleanText.substring(index, index + chunkSize);
        chunks.push(chunk);
        index += (chunkSize - overlap);
    }
    return chunks;
};

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

io.on('connection', (socket) => {
    console.log('A client connected to dashboard socket');
    socket.on('disconnect', () => {
        console.log('Client disconnected from dashboard socket');
    });
});

const prisma = new PrismaClient();

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const getEmbedding = async (text) => {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-embedding-2" });
        const result = await model.embedContent(text);
        return result.embedding.values;
    } catch (err) {
        console.error("Error generating embedding:", err);
        throw err;
    }
};

const sendMessage = async (chatId, text) => {
    try {
        await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
            chat_id: chatId,
            text: text
        });
    } catch (error) {
        console.error("Error sending message:", error?.response?.data || error.message);
    }
};

app.post('/webhook/telegram', async (req, res) => {
    const message = req.body.message;

    if (message && message.text) {
        const chatId = String(message.chat.id);
        const customerName = message.from?.first_name || "Unknown";
        const incomingText = message.text;

        console.log(`[New Message] ${customerName}: ${incomingText}`);

        try {
            await prisma.customer.upsert({
                where: { id: chatId },
                update: { name: customerName },
                create: { id: chatId, name: customerName, platform: "telegram" }
            });

            if (incomingText.toLowerCase() === "/start" || incomingText.toLowerCase() === "/reset") {
                await prisma.conversation.updateMany({
                    where: { customerId: chatId, status: "assigned_to_human" },
                    data: { status: "assigned_to_bot" }
                });
                io.emit('conversation_updated');
                await sendMessage(chatId, "Hello! I am back. How can I help you?");
                return res.sendStatus(200);
            }

            let conversation = await prisma.conversation.findFirst({
                where: { customerId: chatId },
                orderBy: { createdAt: 'desc' }
            });

            if (!conversation) {
                conversation = await prisma.conversation.create({
                    data: { customerId: chatId, status: "assigned_to_bot" }
                });
                io.emit('conversation_updated');
            }

            await prisma.message.create({
                data: {
                    conversationId: conversation.id,
                    sender: "customer",
                    text: incomingText
                }
            });
            io.emit('conversation_updated');

            if (conversation.status === "assigned_to_bot") {
                console.log("Processing request via Gemini...");

                let bestSimilarity = 0;
                let matches = [];
                
                const cleanLower = incomingText.trim().toLowerCase().replace(/[.,!?]/g, "").trim();
                const isGreeting = ["hello", "hi", "hey", "hola", "greetings", "good morning", "good afternoon", "good evening"].some(g => cleanLower === g);

                if (!isGreeting) {
                    try {
                        const queryEmbedding = await getEmbedding(incomingText);
                        const vectorStr = `[${queryEmbedding.join(',')}]`;
                        
                        // 1. Search custom FAQs
                        const faqMatches = await prisma.$queryRawUnsafe(`
                            SELECT question, answer, (1 - (embedding <=> $1::vector)) as similarity, 'faq' as type
                            FROM "KnowledgeBase"
                            WHERE embedding IS NOT NULL
                            ORDER BY embedding <=> $1::vector ASC
                            LIMIT 3;
                        `, vectorStr);
                        
                        // 2. Search PDF document chunks
                        const docMatches = await prisma.$queryRawUnsafe(`
                            SELECT "documentName" as question, content as answer, (1 - (embedding <=> $1::vector)) as similarity, 'doc' as type
                            FROM "DocumentChunk"
                            WHERE embedding IS NOT NULL
                            ORDER BY embedding <=> $1::vector ASC
                            LIMIT 3;
                        `, vectorStr);

                        // 3. Combine and sort by similarity score descending
                        const allMatches = [...faqMatches, ...docMatches].sort((a, b) => b.similarity - a.similarity);
                        
                        // Keep top 3 overall matches
                        matches = allMatches.slice(0, 3);
                        
                        if (matches && matches.length > 0) {
                            bestSimilarity = matches[0].similarity;
                        }
                        console.log(`[RAG Search] Combined search. Best match similarity: ${(bestSimilarity * 100).toFixed(2)}% (Type: ${matches[0]?.type || 'unknown'})`);
                    } catch (err) {
                        console.error("Error during RAG vector search:", err);
                    }
                } else {
                    console.log("[RAG Search] Detected greeting, skipping similarity check.");
                }

                let isConfident = true;
                if (!isGreeting) {
                    if (matches && matches.length > 0) {
                        // Set a lower threshold of 50% to capture conversational or case-based phrasings.
                        // Gemini's reasoning will act as the secondary, intelligent filter to decide relevance.
                        isConfident = matches[0].similarity >= 0.50;
                    } else {
                        isConfident = false;
                    }
                }

                // If not a greeting AND match is not confident, handoff immediately!
                if (!isGreeting && !isConfident) {
                    console.log(`[Confidence Routing] Low confidence match (Best: ${(bestSimilarity * 100).toFixed(2)}% < 50%). Direct Handoff to human.`);

                    await prisma.conversation.update({
                        where: { id: conversation.id },
                        data: { status: "assigned_to_human" }
                    });

                    const handoffMessage = "Connecting you to a customer care executive. Please wait, a human agent will assist you shortly.";
                    await sendMessage(chatId, handoffMessage);

                    await prisma.message.create({
                        data: {
                            conversationId: conversation.id,
                            sender: "bot",
                            text: handoffMessage
                        }
                    });
                    io.emit('conversation_updated');
                } else {
                    // Build context prompt using retrieved matches (or empty if it was a greeting)
                    const formattedKB = matches.map(item => `Q: ${item.question}\nA: ${item.answer}`).join("\n\n");

                    const systemInstruction = `You are a helpful customer support assistant.
You have access to a Knowledge Base. Use ONLY the facts listed in the Knowledge Base to answer the user's query.

Knowledge Base:
${formattedKB || "No information available."}

Rules:
1. If the user is just saying hello or greeting you, reply with a polite greeting and ask how you can help.
2. If the user's query can be answered using the facts in the Knowledge Base, reply with the answer politely and concisely. Do not hallucinate or use any external knowledge.
3. If the user's query CANNOT be answered using the Knowledge Base and is not a simple greeting, reply EXACTLY with the token "[HANDOFF]" (without any other text).`;

                    const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
                    const prompt = `${systemInstruction}\n\nUser query: "${incomingText}"`;

                    const result = await model.generateContent(prompt);
                    const botReply = result.response.text().trim();

                    if (botReply === "[HANDOFF]" || botReply.includes("[HANDOFF]")) {
                        console.log(`[Handoff Triggered by LLM] Handing conversation ${conversation.id} over to human agent.`);

                        await prisma.conversation.update({
                            where: { id: conversation.id },
                            data: { status: "assigned_to_human" }
                        });

                        const handoffMessage = "Connecting you to a customer care executive. Please wait, a human agent will assist you shortly.";
                        await sendMessage(chatId, handoffMessage);

                        await prisma.message.create({
                            data: {
                                conversationId: conversation.id,
                                sender: "bot",
                                text: handoffMessage
                            }
                        });
                        io.emit('conversation_updated');
                    } else {
                        await sendMessage(chatId, botReply);

                        await prisma.message.create({
                            data: {
                                conversationId: conversation.id,
                                sender: "bot",
                                text: botReply
                            }
                        });
                        io.emit('conversation_updated');

                        console.log(`[Gemini Reply]: ${botReply}`);
                    }
                }
            } else {
                console.log(`Message routed to Human Agent (Dashboard). Customer ID: ${chatId}`);
            }
        } catch (error) {
            console.error("Error Processing Request:", error);
            await sendMessage(chatId, "Sorry, I am currently unable to process your request. Please try again later.");
        }
    }

    res.sendStatus(200);
});

app.get('/api/conversations/pending', async (req, res) => {
    try {
        const pendingChats = await prisma.conversation.findMany({
            where: { status: "assigned_to_human" },
            include: {
                messages: { orderBy: { createdAt: 'asc' } },
                customer: true
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(pendingChats);
    } catch (error) {
        console.error("Error fetching chats:", error);
        res.status(500).json({ error: "Failed to fetch conversations" });
    }
});

app.post('/api/admin/reply', async (req, res) => {
    const { conversationId, text } = req.body;

    if (!conversationId || !text) {
        return res.status(400).json({ error: "conversationId and text are required" });
    }

    try {
        const conversation = await prisma.conversation.findUnique({
            where: { id: conversationId },
            include: { customer: true }
        });

        if (!conversation) {
            return res.status(404).json({ error: "Conversation not found" });
        }

        // Save the message to DB first
        await prisma.message.create({
            data: {
                conversationId: conversation.id,
                sender: "human_agent",
                text: text
            }
        });

        // Broadcast update instantly to dashboard
        io.emit('conversation_updated');

        // Respond back to dashboard instantly
        res.json({ success: true, message: "Reply queued successfully" });

        // Dispatch Telegram API request in the background
        sendMessage(conversation.customerId, `Support Team: ${text}`).catch(err => {
            console.error("Failed to send Telegram message asynchronously:", err);
        });
    } catch (error) {
        console.error("Error sending admin reply:", error);
        res.status(500).json({ error: "Failed to send reply" });
    }
});

// KB CRUD Endpoints
app.get('/api/kb', async (req, res) => {
    try {
        const items = await prisma.knowledgeBase.findMany({
            orderBy: { createdAt: 'desc' }
        });
        res.json(items);
    } catch (error) {
        console.error("Error fetching KB:", error);
        res.status(500).json({ error: "Failed to fetch knowledge base" });
    }
});

app.post('/api/kb', async (req, res) => {
    const { question, answer } = req.body;
    if (!question || !answer) {
        return res.status(400).json({ error: "Question and Answer are required" });
    }
    try {
        const newItem = await prisma.knowledgeBase.create({
            data: { question, answer }
        });
        
        // Generate and save embedding
        try {
            const embedding = await getEmbedding(question);
            const vectorStr = `[${embedding.join(',')}]`;
            await prisma.$executeRawUnsafe(
                `UPDATE "KnowledgeBase" SET embedding = $1::vector WHERE id = $2;`,
                vectorStr,
                newItem.id
            );
            console.log(`Saved embedding for new KB item: ${newItem.id}`);
        } catch (err) {
            console.error(`Failed to generate embedding for new KB item ${newItem.id}:`, err);
        }

        res.json(newItem);
    } catch (error) {
        console.error("Error creating KB item:", error);
        res.status(500).json({ error: "Failed to create knowledge base item" });
    }
});

app.put('/api/kb/:id', async (req, res) => {
    const { id } = req.params;
    const { question, answer } = req.body;
    if (!question || !answer) {
        return res.status(400).json({ error: "Question and Answer are required" });
    }
    try {
        const updatedItem = await prisma.knowledgeBase.update({
            where: { id },
            data: { question, answer }
        });

        // Generate and update embedding
        try {
            const embedding = await getEmbedding(question);
            const vectorStr = `[${embedding.join(',')}]`;
            await prisma.$executeRawUnsafe(
                `UPDATE "KnowledgeBase" SET embedding = $1::vector WHERE id = $2;`,
                vectorStr,
                id
            );
            console.log(`Updated embedding for KB item: ${id}`);
        } catch (err) {
            console.error(`Failed to generate embedding for updated KB item ${id}:`, err);
        }

        res.json(updatedItem);
    } catch (error) {
        console.error("Error updating KB item:", error);
        res.status(500).json({ error: "Failed to update knowledge base item" });
    }
});

app.delete('/api/kb/:id', async (req, res) => {
    const { id } = req.params;
    try {
        await prisma.knowledgeBase.delete({
            where: { id }
        });
        res.json({ success: true, message: "KB item deleted successfully" });
    } catch (error) {
        console.error("Error deleting KB item:", error);
        res.status(500).json({ error: "Failed to delete knowledge base item" });
    }
});
// Document PDF Endpoints
app.post('/api/kb/upload-pdf', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
    }
    
    const documentName = req.file.originalname;
    console.log(`[PDF Upload] Processing file: ${documentName}`);
    
    try {
        const uint8Array = new Uint8Array(req.file.buffer);
        const parser = new PDFParse(uint8Array);
        await parser.load();
        const result = await parser.getText();
        const text = result.text;
        await parser.destroy();
        
        if (!text || text.trim().length === 0) {
            return res.status(400).json({ error: "Could not extract text from PDF" });
        }
        
        const chunks = chunkText(text);
        console.log(`[PDF Upload] Generated ${chunks.length} chunks for ${documentName}`);
        
        // Process each chunk sequentially
        for (let i = 0; i < chunks.length; i++) {
            const chunkContent = chunks[i];
            const chunkId = `doc_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 9)}`;
            
            const embedding = await getEmbedding(chunkContent);
            const vectorStr = `[${embedding.join(',')}]`;
            
            await prisma.$executeRawUnsafe(
                `INSERT INTO "DocumentChunk" (id, "documentName", content, embedding) VALUES ($1, $2, $3, $4::vector);`,
                chunkId,
                documentName,
                chunkContent,
                vectorStr
            );
        }
        
        res.json({ success: true, message: `Successfully parsed and stored ${chunks.length} chunks for ${documentName}` });
    } catch (err) {
        console.error("[PDF Upload Error]:", err);
        res.status(500).json({ error: "Failed to parse and store PDF chunks" });
    }
});

app.get('/api/documents', async (req, res) => {
    try {
        const docs = await prisma.$queryRawUnsafe(`
            SELECT "documentName", COUNT(*)::int as chunks, MIN("createdAt") as "createdAt"
            FROM "DocumentChunk"
            GROUP BY "documentName"
            ORDER BY "createdAt" DESC;
        `);
        res.json(docs);
    } catch (error) {
        console.error("Error fetching documents:", error);
        res.status(500).json({ error: "Failed to fetch documents" });
    }
});

app.delete('/api/documents/:name', async (req, res) => {
    const { name } = req.params;
    try {
        await prisma.$executeRawUnsafe(
            `DELETE FROM "DocumentChunk" WHERE "documentName" = $1;`,
            name
        );
        res.json({ success: true, message: `Document ${name} and its chunks deleted successfully` });
    } catch (error) {
        console.error("Error deleting document:", error);
        res.status(500).json({ error: "Failed to delete document" });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});