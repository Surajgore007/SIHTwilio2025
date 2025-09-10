# Use official Node.js runtime as base image
FROM node:16

# Set environment to production
ENV NODE_ENV=production

# Set working directory in container
WORKDIR /app

# Copy package files first (for better caching)
COPY ["package.json", "package-lock.json*", "./"]

# Install dependencies
RUN npm install --production

# Copy all application files
COPY . .

# Create media directory
RUN mkdir -p media

# Expose port (Back4App will handle the PORT env variable)
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]