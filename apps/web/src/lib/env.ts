// Environment switches read in more than one place (API routes and pages).

/** public registration is open unless REGISTRATION_ENABLED=false */
export const registrationEnabled = () => (process.env.REGISTRATION_ENABLED ?? "true").toLowerCase() !== "false";
