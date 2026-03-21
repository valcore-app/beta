import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      isOpsAdmin?: boolean;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    isOpsAdmin?: boolean;
  }
}
