# Stripe webhook bridge: forwards live account events to revenue-engine.
# Reads the secret key from master.env at startup; never prints it.
$line = (Get-Content C:\Users\keith\master.env | Select-String '^STRIPE_SECRET_KEY=').Line
$env:STRIPE_API_KEY = $line.Substring('STRIPE_SECRET_KEY='.Length)
& "$env:APPDATA\npm\stripe.cmd" listen --forward-to localhost:8787/webhook 2>&1
