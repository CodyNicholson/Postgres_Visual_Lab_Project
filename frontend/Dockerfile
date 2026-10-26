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

# Unprivileged nginx runs as uid 101, not root. It can still listen on 80 because Docker lets
# containers bind low ports (net.ipv4.ip_unprivileged_port_start=0).
FROM nginxinc/nginx-unprivileged:1.31-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY security-headers.conf /etc/nginx/snippets/security-headers.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
