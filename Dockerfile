FROM node:20-alpine

# Create app directory inside container
WORKDIR /app

# Copy dependency files first (better caching)
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy the rest of the project
COPY .   .

# App runs on port 3000
EXPOSE 3000

# Start the app
CMD ["npm", "start"]
