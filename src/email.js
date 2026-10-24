// Transactional email: Gmail SMTP (works to ANY customer, no domain needed) with
// Resend fallback. Both free.
// SMTP mode (preferred, delivers to real customers) — master.env needs:
//   SMTP_HOST=smtp.gmail.com  SMTP_PORT=465  SMTP_USER=<your gmail>  SMTP_PASS=<16-char app password>
//   (app password: myaccount.google.com -> Security -> 2-Step Verification -> App passwords)
// Resend mode (TEST ONLY: delivers to the account owner's own inbox, not customers):
//   RESEND_API_KEY set.
export async function sendLicenseEmail(email, licenseKey, tier) {
  const storeUrl = process.env.SITE_URL || "https://21leahcimhtiek-oss.github.io/aurora-rayes-store/";
  const text = `Welcome!\n\nYour tier: ${tier}\nLicense key: ${licenseKey}\n\nLog in at ${storeUrl} with your email + this key.\n\nKeep this email — lost keys are recovered via your purchase email.`;
  const from = process.env.EMAIL_FROM || "Aurora Rayes LLC";

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({ from, to: email, subject: "Your ccpi license key", text });
    return;
  }

  if (process.env.RESEND_API_KEY) {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.EMAIL_FROM || "Aurora Rayes LLC <onboarding@resend.dev>",
      to: email,
      subject: "Your ccpi license key",
      text,
    });
    return;
  }

  console.log(`[DRY-RUN email] to=${email} tier=${tier} key=${licenseKey}`);
}
