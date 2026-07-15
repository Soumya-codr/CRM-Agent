require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const prisma = new PrismaClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function run() {
    try {
        console.log("1. Enabling pgvector extension if not exists...");
        await prisma.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS vector;");
        console.log("pgvector extension enabled.");

        console.log("2. Adding 'embedding' column of type vector(3072) to KnowledgeBase table...");
        await prisma.$executeRawUnsafe('ALTER TABLE "KnowledgeBase" ADD COLUMN IF NOT EXISTS embedding vector(3072);');
        console.log("Column verification/addition complete.");

        console.log("3. Fetching KnowledgeBase items that do not have embeddings...");
        const items = await prisma.$queryRawUnsafe('SELECT id, question FROM "KnowledgeBase" WHERE embedding IS NULL;');
        console.log(`Found ${items.length} items to backfill.`);

        const model = genAI.getGenerativeModel({ model: "gemini-embedding-2" });

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            console.log(`Processing item ${i + 1}/${items.length}: "${item.question}" (ID: ${item.id})`);
            
            try {
                // Generate embedding
                const result = await model.embedContent(item.question);
                const embedding = result.embedding.values;

                if (!embedding || embedding.length !== 3072) {
                    throw new Error(`Invalid embedding length generated: ${embedding ? embedding.length : 0}`);
                }

                // Format vector for pgvector
                const vectorStr = `[${embedding.join(',')}]`;

                // Update database
                await prisma.$executeRawUnsafe(
                    'UPDATE "KnowledgeBase" SET embedding = $1::vector WHERE id = $2;',
                    vectorStr,
                    item.id
                );
                console.log(`Successfully updated embedding for item ID: ${item.id}`);

                // Brief pause to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (err) {
                console.error(`Failed to process item ID ${item.id}:`, err.message);
            }
        }

        console.log("Backfill process finished successfully!");
    } catch (e) {
        console.error("Migration/Backfill failed:", e);
    } finally {
        await prisma.$disconnect();
    }
}

run();
