EasyLayer provides a suite of ready-to-use self-hosted solutions for blockchain indexing and real-time crypto processing. Our tools are designed to empower developers and businesses to efficiently interact with the blockchains network through robust and scalable applications.

## 📚 Documentation & Website

- **Documentation:** [https://docs.easylayer.io/](https://docs.easylayer.io/)
- **Website:** [https://easylayer.io/](https://easylayer.io/)

## 🛠️ Available Solutions

EasyLayer currently offers four core application concepts for the Bitcoin network:

1. **[Bitcoin Loader (Experimental)](https://github.com/EasyLayer/bitcoin-loader)**
   - *Stage:* Beta Testing Version

2. **[Bitcoin Indexer (Proof of Concept)](https://github.com/EasyLayer/bitcoin-indexer)**
   - *Stage:* Proof of Concept

3. **[Bitcoin Listener (Proof of Concept)](https://github.com/EasyLayer/bitcoin-listener)**
   - *Stage:* Proof of Concept

4. **[Bitcoin Wallet (Proof of Concept)](https://github.com/EasyLayer/bitcoin-wallet)**
   - *Stage:* Proof of Concept

Click on each link to access detailed descriptions and documentation for each solution. We are continuously developing beta versions for these applications to enhance their capabilities and stability.

## Prerequisites

- **Node.js:** Version 18 or higher
- **TypeScript:** As the primary programming language

## 🧩 Our Concept

Our solutions are built on the following **principles and technologies**:

- **Node.js & TypeScript:** Ensuring modern, efficient, and type-safe development.
- **NestJS:** Leveraging NestJS for a modern, robust, and scalable software architecture.
- **Event Sourcing:** Capturing all changes to an application state as a sequence of events.
- **Command Query Responsibility Segregation (CQRS):** Separating read and write operations for better scalability and maintainability.
- **Domain-Driven Design (DDD):** Structuring the software around the business domain for clarity and flexibility.

Developers define **database schemas** and **data storage mechanisms**, then run the applications on their own machines. Our applications communicate via **RPC** to request blocks from their own node or a provider, process the data, and store it in the appropriate database according to the defined schema. This approach ensures that our solutions are **universal** and **adaptable** to any data scheme.
