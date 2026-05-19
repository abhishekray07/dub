import { PlainClient } from "@team-plain/typescript-sdk";

export const plain = new PlainClient({
  apiKey: process.env.PLAIN_API_KEY || "missing-plain-api-key",
});

export type PlainUser = {
  id: string;
  name: string | null;
  email: string | null;
};
