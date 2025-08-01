FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Build the application
RUN npm run build

# Remove source files and dev dependencies
RUN rm -rf src tsconfig.json

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S haip -u 1001

# Change ownership of the app directory
RUN chown -R haip:nodejs /app
USER haip

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the server
CMD ["node", "dist/index.js"] 