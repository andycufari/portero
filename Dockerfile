FROM node:20-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY src ./src
COPY config ./config

# Build TypeScript
RUN npm run build

# Create data and logs directories
RUN mkdir -p data logs

# Expose port
EXPOSE 8443

# Start the gateway
CMD ["npm", "start"]
