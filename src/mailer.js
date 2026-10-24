// Shared outbound mailer: SMTP (real customers) → Resend (test) → dry-run.
export async function sendMail(to, subject, text) {
  const from = process.env.EMAIL_FROM || "Aurora Rayes LLC";
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    const nodemailer = (await import("nodemailer")).default;
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({ from, to, subject, text });
    return "smtp";
  }
  if (process.env.RESEND_API_KEY) {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.EMAIL_FROM || "Aurora Rayes LLC <onboarding@resend.dev>",
      to, subject, text,
    });
    return "resend";
  }
  console.log(`[DRY-RUN mail] to=${to} subject=${subject}`);
  return "dry-run";
}
