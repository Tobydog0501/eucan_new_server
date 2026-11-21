FROM nginx:1.31.9

# Optional: pin the backend API base, e.g. --build-arg API_BASE=https://api.example:3000
# Left empty (the default), pages call port 3000 on the host they were loaded
# from, which in production is the address they always used.
ARG API_BASE=

COPY . /usr/share/nginx/html/
RUN if [ -n "$API_BASE" ]; then \
        echo "$API_BASE" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$' \
            || { echo "API_BASE must look like http(s)://host[:port]" >&2; exit 1; }; \
        sed -i "s|^var EUCAN_API_BASE_CONFIGURED = ''; // @API_BASE@|var EUCAN_API_BASE_CONFIGURED = '${API_BASE}'; // @API_BASE@|" \
            /usr/share/nginx/html/js/cookieOperation.js \
        && grep -q "EUCAN_API_BASE_CONFIGURED = '${API_BASE}'" /usr/share/nginx/html/js/cookieOperation.js; \
    fi

# Remove the default nginx.conf
RUN rm /etc/nginx/conf.d/default.conf

# # Replace with our own nginx.conf
COPY nginx.conf /etc/nginx/conf.d/
