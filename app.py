import os

# Business details shown in the footer, legal pages and emails. Set these in
# your hosting environment; the bracketed defaults are visible placeholders.
BUSINESS = {
    "name": os.getenv("BUSINESS_NAME", "BlueMart").strip(),
    "address": os.getenv("BUSINESS_ADDRESS", "Addis Ababa, Ethiopia").strip(),
    "country": os.getenv("BUSINESS_COUNTRY", "Ethiopia").strip(),
    "email": os.getenv("SUPPORT_EMAIL", "eyoeleyosiyas@gmail.com").strip(),
}
