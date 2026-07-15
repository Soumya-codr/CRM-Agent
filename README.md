# OmniAgent RAG Support System

OmniAgent is an omnichannel customer support automation system. It features a RAG (Retrieval-Augmented Generation) bot powered by Gemini and pgvector (PostgreSQL) that automatically answers customer inquiries on Telegram, combined with an administrative dashboard for human agent intervention and document management.

---

## 1. System Architecture & Data Flow

This diagram illustrates how an incoming customer message is processed, searched semantically, evaluated for confidence, and either answered by the bot or routed to a human agent.

```mermaid
graph TD
    A[Telegram User Message] --> B[POST /webhook/telegram]
    B --> C{Is simple greeting?}
    C -- Yes --> D[Bypass Similarity Search]
    C -- No --> E[Generate Query Embedding via Gemini]
    E --> F[Query PostgreSQL Database]
    F --> G[Retrieve Top 3 FAQ matches]
    F --> H[Retrieve Top 3 PDF Document chunks]
    G --> I[Merge and Sort by Cosine Similarity]
    H --> I
    I --> J{Best Similarity >= 50%?}
    J -- No --> K[Route to Human Agent]
    J -- Yes --> L[Assemble Context and Send to Gemini]
    D --> L
    L --> M{Gemini Output Contains [HANDOFF]?}
    M -- Yes --> K
    M -- No --> N[Save Response & Send to Telegram]
    K --> O[Update Status: assigned_to_human]
    O --> P[Notify Dashboard via WebSockets]
```

---

## 2. High-Level Design (HLD)

The system consists of three main decoupled services communicating over HTTP, WebSockets, and database drivers.

```mermaid
graph LR
    subgraph Client-Side
        Telegram[Telegram Bot Platform]
        Dashboard[React Admin Dashboard]
    end

    subgraph Server-Side
        Backend[Express.js Server]
        Postgres[(PostgreSQL + pgvector)]
        Gemini[Gemini API]
    end

    Telegram <-->|HTTP Webhook| Backend
    Dashboard <-->|HTTP REST & Socket.io| Backend
    Backend <-->|Prisma Client| Postgres
    Backend <-->|HTTPS API| Gemini
```

### Component Details
* **React Dashboard**: Provides a visual interface to monitor active conversations, manually reply (intervene), and upload/delete training PDF files.
* **Express Backend**: Exposes endpoints for bot webhooks, dashboard REST APIs, file parsing pipelines, and manages socket.io server communication.
* **PostgreSQL Database**: Configured with the `vector` extension to store 3072-dimensional embeddings alongside structured chat messages, customers, and knowledge base entities.
* **Gemini LLM**: Used as both an embedding generator (`gemini-embedding-2`) and a reasoning engine (`gemini-3.1-flash-lite`) to produce context-constrained support answers.

---

## 3. Low-Level Design (LLD)

### 3.1 Database Schema (Prisma)
The database structure is defined in `prisma/schema.prisma` and models the following entities:

```prisma
model Customer {
  id            String         @id
  name          String
  platform      String
  conversations Conversation[]
  createdAt     DateTime       @default(now())
}

model Conversation {
  id          String    @id @default(uuid())
  customerId  String
  customer    Customer  @relation(fields: [customerId], references: [id])
  status      String    // "assigned_to_bot" | "assigned_to_human"
  messages    Message[]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}

model Message {
  id             String       @id @default(uuid())
  conversationId String
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  sender         String       // "customer" | "bot" | "human_agent"
  text           String
  createdAt      DateTime     @default(now())
}

model KnowledgeBase {
  id        String                    @id @default(uuid())
  question  String
  answer    String
  embedding Unsupported("vector(3072)")?
  createdAt DateTime                  @default(now())
}

model DocumentChunk {
  id           String                    @id @default(uuid())
  documentName String
  content      String
  embedding    Unsupported("vector(3072)")
  createdAt    DateTime                  @default(now())
}
```

### 3.2 REST API Endpoints

#### Dashboard Operations
* `GET /api/conversations/pending`: Fetches human-assigned active support conversations.
* `POST /api/admin/reply`: Allows a human agent to send replies and resolves customer intervention.

#### FAQ Knowledge Base Operations
* `GET /api/kb`: Retrieves all custom Q&A items.
* `POST /api/kb`: Creates a new custom Q&A and generates its embedding.

#### Document Repository Operations
* `POST /api/kb/upload-pdf`: Accepts a multipart PDF, extracts text via `pdf-parse`, splits it into 600-character overlapping chunks, computes embeddings, and indexes them.
* `GET /api/documents`: Lists unique uploaded document names and chunk counts.
* `DELETE /api/documents/:name`: Removes a document and cleans up all its chunks from the database.

---

## 4. Local Installation and Setup

### Prerequisites
* Node.js (v20.x or above)
* PostgreSQL database with the `vector` extension enabled.
* Gemini API Key

### 4.1 Backend Setup
1. Navigate to the backend directory:
   ```bash
   cd omnichannel-agent
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure the `.env` file with your credentials:
   ```env
   TELEGRAM_TOKEN="your-telegram-bot-token"
   DATABASE_URL="postgresql://username:password@host:port/database"
   GEMINI_API_KEY="your-gemini-api-key"
   PORT=3000
   ```
4. Push Prisma schema and migrate:
   ```bash
   npx prisma db push
   ```
5. Run the embedding backfill script for existing FAQs:
   ```bash
   node scripts/backfill_embeddings.js
   ```
6. Start the server:
   ```bash
   npm start
   ```

### 4.2 Frontend Setup
1. Navigate to the frontend directory:
   ```bash
   cd dashboard-frontend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the Vite development server:
   ```bash
   npm run dev
   ```
