FROM nginx:1.31.9@sha256:84f7876d21d154885f99554d7ae325d8c2213f9169726ea7ab60642f2573a787

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

# Optional: point the "cloud history" links on admin/calendar.html and
# admin/record.html elsewhere. Empty (the default) keeps the folders built into
# the pages, as before.
ARG CLOUD_HISTORY_URL_CALENDAR=
ARG CLOUD_HISTORY_URL_RECORD=
RUN sh /usr/share/nginx/html/cloud_links.sh /usr/share/nginx/html keep

# Remove the default nginx.conf
# nginx.conf is needed in the build context for the COPY below, but must not
# be served from the web root; cloud_links.sh is a build file.
RUN rm /etc/nginx/conf.d/default.conf /usr/share/nginx/html/nginx.conf /usr/share/nginx/html/cloud_links.sh

# # Replace with our own nginx.conf
COPY nginx.conf /etc/nginx/conf.d/
