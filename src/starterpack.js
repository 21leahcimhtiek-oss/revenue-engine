// Lead magnet: free Aurora OS Starter Pack delivery (double opt-in ready).
// SMTP first (delivers to any lead), Resend fallback (test-only, own inbox).
export async function sendStarterPackEmail(email) {
  const from = process.env.EMAIL_FROM || "Aurora Rayes LLC";
  const site = process.env.SITE_URL || "https://21leahcimhtiek-oss.github.io/aurora-rayes-store/";
  const subject = "Your free Aurora OS Starter Pack";
  const text = `Here's your free Aurora OS Starter Pack.\n\nDownload: ${site}\nSkill catalog: ${site}\n\nYou'll also get new skill drops and pack updates. Unsubscribe any time.`;

  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({ from, to: email, subject, text });
    return;
  }

  if (process.env.RESEND_API_KEY) {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({ from: process.env.EMAIL_FROM || "Aurora Rayes LLC <onboarding@resend.dev>", to: email, subject, text });
    return;
  }

  console.log(`[DRY-RUN starter-pack] to=${email}`);
}
