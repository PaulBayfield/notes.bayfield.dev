# Web build, served under /app/ so it can sit on Outline's own domain.
#   docker build -t notes . && docker run -p 8788:80 notes

FROM node:24-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY src ./src
COPY public ./public
ENV VITE_BASE=/app/
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web /app/dist /usr/share/nginx/html/app
EXPOSE 80
