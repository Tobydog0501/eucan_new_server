#!/bin/sh
# Set the "cloud history" folder links on admin/calendar.html and admin/record.html
# at image build time. Used by Dockerfile and Dockerfile_test; removed from the
# web root afterwards.
#
#   cloud_links.sh <web root> keep|hide
#
#   CLOUD_HISTORY_URL_CALENDAR  https URL for admin/calendar.html
#   CLOUD_HISTORY_URL_RECORD    https URL for admin/record.html
#
# A link whose variable is empty keeps the folder built into the page ("keep",
# production) or is hidden ("hide", test site). Any other value must be an
# https URL; anything else fails the build.
set -eu

root=$1
mode=$2
case "$mode" in keep|hide) ;; *) echo "cloud_links.sh: mode must be keep or hide" >&2; exit 1 ;; esac

set_link() {
  key=$1
  url=$2
  page="$root/admin/$key.html"
  grep -q "data-cloud-link=\"$key\"" "$page" || { echo "cloud_links.sh: no $key link in $page" >&2; exit 1; }
  if [ -n "$url" ]; then
    printf '%s' "$url" | grep -Eq '^https://[A-Za-z0-9._~:/?#@!&=+%,-]+$' \
      || { echo "cloud_links.sh: the $key URL must be an https URL" >&2; exit 1; }
    esc=$(printf '%s' "$url" | sed 's/&/\\&/g')
    sed -i "s|href=\"[^\"]*\" data-cloud-link=\"$key\"|href=\"$esc\" data-cloud-link=\"$key\"|" "$page"
    grep -qF "href=\"$url\" data-cloud-link=\"$key\"" "$page" \
      || { echo "cloud_links.sh: could not set the $key link" >&2; exit 1; }
  elif [ "$mode" = hide ]; then
    sed -i "s|href=\"[^\"]*\" data-cloud-link=\"$key\"|hidden style=\"display:none\" data-cloud-link=\"$key\"|" "$page"
    grep -qF "hidden style=\"display:none\" data-cloud-link=\"$key\"" "$page" \
      || { echo "cloud_links.sh: could not hide the $key link" >&2; exit 1; }
  fi
}

set_link calendar "${CLOUD_HISTORY_URL_CALENDAR:-}"
set_link record "${CLOUD_HISTORY_URL_RECORD:-}"
