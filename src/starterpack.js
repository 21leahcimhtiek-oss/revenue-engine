// Lead magnet: free Aurora OS Starter Pack delivery (double opt-in ready).
export async function sendStarterPackEmail(email) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[DRY-RUN starter-pack] to=${email}`);
    return;
  }
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.EMAIL_FROM || "Tons of Skills <licenses@yourdomain.com>";
  const site = process.env.SITE_URL || "https://tonsofskills.com";
  await resend.emails.send({
    from,
    to: email,
    subject: "Your free Aurora OS Starter Pack",
    text: `Here's your free Aurora OS Starter Pack.\n\nDownload: ${site}/downloads\nSkill catalog: ${site}/skills\n\nYou'll also get new skill drops and pack updates. Unsubscribe any time.`,
  });
}
