# Production image: Vite builds a minified bundle, nginx serves it on port 80
# and proxies /api (REST + Server-Sent Events) to the backend.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY . .
RUN npm run build

# Test stage: `docker build --target test ./frontend` runs the Vitest unit tests
FROM build AS test
RUN npm test

FROM nginx:alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
