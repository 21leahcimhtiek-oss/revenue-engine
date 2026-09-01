// Transactional email via Resend (free tier: 100 emails/day, no credit card).
// Provider-agnostic: swap this one file for Postmark/SendGrid/Brevo without touching server.js.
export async function sendLicenseEmail(email, licenseKey, tier) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[DRY-RUN email] to=${email} tier=${tier} key=${licenseKey}`);
    return;
  }
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: process.env.EMAIL_FROM || "Tons of Skills <licenses@yourdomain.com>",
    to: email,
    subject: "Your ccpi license key",
    text: `Welcome!\n\nYour tier: ${tier}\nLicense key: ${licenseKey}\n\nLog in at https://yourdomain.com/login with your email + this key.\n\nKeep this email — lost keys are recovered via your purchase email.`,
  });
}
