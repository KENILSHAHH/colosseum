"use client";

import { usePrivy, useSigners } from "@privy-io/react-auth";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, post, token, type Me } from "./api";

const WALLET_RETRIES = 10;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Privy sign-in. Privy creates the wallet of the user. The server exchanges the Privy token for a session token. */
export function useSession() {
  const { ready, authenticated, user, login, logout, getAccessToken } = usePrivy();
  const qc = useQueryClient();
  const [hasToken, setHasToken] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const exchanging = useRef(false);

  // The embedded wallet appears a moment after the first login.
  const wallet = user?.linkedAccounts.find((a) => a.type === "wallet" && a.chainType === "ethereum" && a.connectorType === "embedded");
  const walletAddress = wallet?.type === "wallet" ? wallet.address : undefined;

  useEffect(() => {
    if (!ready) return;
    // A session token without a Privy login belongs to an earlier user.
    if (!authenticated) token.clear();
    setHasToken(authenticated && !!token.get());
  }, [ready, authenticated]);

  const exchange = useCallback(async () => {
    if (exchanging.current) return;
    exchanging.current = true;
    setSigningIn(true);
    setError(null);
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await post<{ token: string }>("/auth/privy", { accessToken: await getAccessToken() });
          token.set(res.token);
          setHasToken(true);
          await qc.invalidateQueries({ queryKey: ["me"] });
          return;
        } catch (e) {
          // 409: Privy does not show the new wallet to the server yet.
          if (!(e instanceof ApiError && e.status === 409) || attempt >= WALLET_RETRIES) throw e;
          await wait(1500);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0]! : "Sign-in failed");
    } finally {
      exchanging.current = false;
      setSigningIn(false);
    }
  }, [getAccessToken, qc]);

  useEffect(() => {
    if (ready && authenticated && walletAddress && !hasToken && !error) void exchange();
  }, [ready, authenticated, walletAddress, hasToken, error, exchange]);

  const me = useQuery({
    queryKey: ["me", user?.id],
    enabled: hasToken && authenticated,
    queryFn: async () => {
      try {
        return await api<Me>("/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          token.clear();
          setHasToken(false);
        }
        throw e;
      }
    },
  });

  // The server signer lets the deposit converter move tokens that arrive in the Privy wallet. One attempt for each page load.
  const { addSigners } = useSigners();
  const signerTried = useRef(false);
  const deposit = me.data?.deposit;
  useEffect(() => {
    if (!deposit?.address || deposit.enabled || !deposit.signerId || signerTried.current) return;
    signerTried.current = true;
    void (async () => {
      try {
        await addSigners({ address: deposit.address!, signers: [{ signerId: deposit.signerId!, policyIds: [] }] });
        await post("/deposit/enable");
        await qc.invalidateQueries({ queryKey: ["me"] });
      } catch (e) {
        console.warn("The server signer was not added to the Privy wallet:", e);
      }
    })();
  }, [deposit?.address, deposit?.enabled, deposit?.signerId, addSigners, qc]);

  const signIn = useCallback(() => {
    setError(null);
    if (authenticated) void exchange();
    else login();
  }, [authenticated, exchange, login]);

  const signOut = useCallback(async () => {
    token.clear();
    setHasToken(false);
    setError(null);
    qc.clear();
    await logout();
  }, [logout, qc]);

  return {
    ready,
    authenticated,
    label: user?.email?.address ?? user?.google?.email ?? null,
    me: me.data ?? null,
    signedIn: authenticated && !!me.data,
    signIn,
    signOut,
    signingIn: signingIn || (authenticated && !walletAddress),
    error,
    refresh: () => qc.invalidateQueries({ queryKey: ["me"] }),
  };
}
