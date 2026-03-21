import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";
import GoogleProvider from "next-auth/providers/google";
import { Pool } from "pg";
import PostgresAdapter from "@auth/pg-adapter";
import { isOpsAdmin } from "./ops-admins";
import { resolveDbSsl } from "./db-ssl";

const fetchGitHubEmail = async (accessToken?: string | null) => {
  if (!accessToken) return null;
  try {
    const response = await fetch("https://api.github.com/user/emails", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) return null;
    const emails = (await response.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    const primary = emails.find((item) => item.primary && item.verified);
    const fallback = emails.find((item) => item.verified);
    return primary?.email ?? fallback?.email ?? null;
  } catch {
    return null;
  }
};

const buildProviders = () => {
  const oauthProviders = [];
  if (process.env.GITHUB_ID && process.env.GITHUB_SECRET) {
    oauthProviders.push(
      GitHubProvider({
        clientId: process.env.GITHUB_ID,
        clientSecret: process.env.GITHUB_SECRET,
        authorization: { params: { scope: "read:user user:email" } },
        profile: async (profile, tokens) => {
          const email =
            profile.email ??
            (tokens?.access_token ? await fetchGitHubEmail(tokens.access_token) : null);
          return {
            id: profile.id?.toString(),
            name: profile.name ?? profile.login,
            email,
            image: profile.avatar_url,
          };
        },
      }),
    );
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    oauthProviders.push(
      GoogleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      }),
    );
  }
  return oauthProviders;
};

const getAuthPool = () => {
  const url =
    process.env.AUTH_DATABASE_URL ??
    process.env.APP_WRITE_DATABASE_URL;
  if (!url) {
    return null;
  }
  return new Pool({
    connectionString: url,
    ssl: resolveDbSsl(url),
    max: 5,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
  });
};

const oauthProviders = buildProviders();
const authPool = getAuthPool();

export const authRuntime = {
  hasProviders: oauthProviders.length > 0,
  hasDatabase: Boolean(authPool),
};

export const authOptions: NextAuthOptions = {
  ...(authPool ? { adapter: PostgresAdapter(authPool) } : {}),
  session: { strategy: "jwt" },
  providers: [...oauthProviders],
  pages: {
    signIn: "/ops/login",
    error: "/ops/login",
  },
  callbacks: {
    async signIn({ user, account }) {
      let email = user.email;
      if (!email && account?.provider === "github") {
        email = await fetchGitHubEmail(account.access_token);
        if (email) {
          user.email = email;
        }
      }
      return await isOpsAdmin(email);
    },
    async jwt({ token, user, account }) {
      if (user?.email) {
        token.isOpsAdmin = await isOpsAdmin(user.email);
      } else if (account?.provider === "github") {
        const email = await fetchGitHubEmail(account.access_token);
        if (email) {
          token.isOpsAdmin = await isOpsAdmin(email);
          token.email = email;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.isOpsAdmin = Boolean(token.isOpsAdmin);
      }
      return session;
    },
  },
};
