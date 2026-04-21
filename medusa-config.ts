const { loadEnv, defineConfig } = require('@medusajs/framework/utils')

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

// Ensure Vite sees the backend URL if only the non-VITE version is provided
if (process.env.MEDUSA_ADMIN_BACKEND_URL && !process.env.VITE_MEDUSA_ADMIN_BACKEND_URL) {
  process.env.VITE_MEDUSA_ADMIN_BACKEND_URL = process.env.MEDUSA_ADMIN_BACKEND_URL
}

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    databaseDriverOptions: {
      connection: {
        ssl: {
          rejectUnauthorized: false,
        },
      },
    },
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  admin: {
    backendUrl: process.env.VITE_MEDUSA_ADMIN_BACKEND_URL || process.env.MEDUSA_ADMIN_BACKEND_URL,
    disable: process.env.MEDUSA_ADMIN_DISABLED === "true",
  },
})
