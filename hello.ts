// hello.ts - A simple diagnostic server to test environment variables.

Deno.serve(req => {
  // Try to get the environment variable.
  const token = Deno.env.get("TELEGRAM_TOKEN");

  // This is the most important part. We log EXACTLY what Deno Deploy sees.
  console.log("--- STARTING DIAGNOSTIC TEST ---");
  console.log(`Attempting to read 'TELEGRAM_TOKEN'...`);
  console.log(`Value found: ${token}`);
  console.log(`Type of value: ${typeof token}`);
  console.log("---  END OF DIAGNOSTIC TEST  ---");

  // Prepare a response to show in the browser.
  let body = "";
  if (token) {
    // Obscure the token for security, but confirm it was found.
    const obscuredToken = token.slice(0, 4) + "..." + token.slice(-4);
    body = `
      <body style="font-family: sans-serif; background-color: #e0ffe0;">
        <h1>✅ Success!</h1>
        <p>The TELEGRAM_TOKEN environment variable was found.</p>
        <p>Value: <code>${obscuredToken}</code></p>
      </body>
    `;
  } else {
    body = `
      <body style="font-family: sans-serif; background-color: #ffe0e0;">
        <h1>❌ Failure!</h1>
        <p>The TELEGRAM_TOKEN environment variable was NOT found.</p>
        <p>The value returned by Deno.env.get() was undefined.</p>
      </body>
    `;
  }

  return new Response(body, {
    headers: { "content-type": "text/html" },
  });
});

console.log("Diagnostic server is running.");