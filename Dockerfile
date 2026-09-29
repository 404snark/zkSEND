FROM node:22-alpine
WORKDIR /srv
COPY fonts ./fonts
COPY img ./img
COPY package.json build.js server.js template.html style.css app.js qrlib.min.js challenge.template.html challenge.css challenge.js ./
RUN node build.js && rm -f template.html style.css app.js qrlib.min.js challenge.template.html challenge.css challenge.js build.js && rm -f fonts/*.woff2
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "server.js"]
