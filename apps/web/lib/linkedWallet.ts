"use client";

import { useConnectWallet, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { api, post, type Permission } from "./api";

interface ToSign { permission: Permission; upgraded: boolean; typedData: Record<string, unknown> }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (e: unknown, fallback: string) => (e instanceof Error ? e.message.split("\n")[0]! : fallback);

/**
 * The user's own wallet (MetaMask or another external wallet).
 * `link` proves ownership with a signed text. `grant` signs one permission for the agent (an EIP-7702 delegation).
 */
export function useLinkedWallet() {
  const qc = useQueryClient();
  const { wallets } = useWallets();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const afterConnect = useRef<((w: ConnectedWallet) => void) | null>(null);
  const { connectWallet } = useConnectWallet({
    onSuccess: ({ wallet }) => {
      const run = afterConnect.current;
      afterConnect.current = null;
      if (run && "getEthereumProvider" in wallet) run(wallet as ConnectedWallet);
    },
  });
  const external = wallets.filter((w) => w.walletClientType !== "privy" && w.walletClientType !== "privy-v2");

  const linkWith = useCallback(
    async (wallet: ConnectedWallet) => {
      setBusy("link");
      setError(null);
      try {
        const provider = await wallet.getEthereumProvider();
        const { nonce, message } = await post<{ nonce: string; message: string }>("/wallet/link/nonce", { address: wallet.address });
        const signature = await provider.request({ method: "personal_sign", params: [message, wallet.address] });
        await post("/wallet/link", { address: wallet.address, nonce, signature });
        await qc.invalidateQueries({ queryKey: ["me"] });
      } catch (e) {
        setError(short(e, "The wallet was not linked"));
      } finally {
        setBusy(null);
      }
    },
    [qc],
  );

  /** Open the wallet list. The link starts when a wallet connects. */
  const link = useCallback(() => {
    setError(null);
    afterConnect.current = linkWith;
    connectWallet();
  }, [connectWallet, linkWith]);

  const unlink = useCallback(async () => {
    await api("/wallet/link", { method: "DELETE" });
    for (const k of ["me", "permissions"]) qc.invalidateQueries({ queryKey: [k] });
  }, [qc]);

  const grant = useCallback(
    async (id: string, onStep?: (text: string) => void) => {
      setBusy(id);
      setError(null);
      try {
        const info = await api<ToSign>(`/permissions/${id}`);
        const owner = info.permission.owner;
        const wallet = external.find((w) => w.address.toLowerCase() === owner);
        if (!wallet) {
          connectWallet();
          throw new Error(`Connect the wallet ${owner.slice(0, 6)}…${owner.slice(-4)}, then click again.`);
        }
        onStep?.(`Switch to ${info.permission.chainName}`);
        await wallet.switchChain(info.permission.chainId);
        const provider = await wallet.getEthereumProvider();

        if (!info.upgraded) {
          // A batch of two empty calls makes the wallet offer the smart account upgrade (EIP-7702, through EIP-5792).
          onStep?.("Approve the smart account upgrade in your wallet");
          const empty = { to: wallet.address, value: "0x0", data: "0x" };
          await provider.request({ method: "wallet_sendCalls", params: [{ version: "2.0.0", from: wallet.address, chainId: `0x${info.permission.chainId.toString(16)}`, atomicRequired: true, calls: [empty, empty] }] });
          onStep?.("Wait for the upgrade");
          let upgraded = false;
          for (let i = 0; i < 40 && !upgraded; i++) {
            await wait(3000);
            upgraded = (await api<ToSign>(`/permissions/${id}`)).upgraded;
          }
          if (!upgraded) throw new Error("The upgrade is not on-chain yet. Wait a moment, then click again.");
        }

        onStep?.("Sign the permission in your wallet");
        let signature: unknown;
        try {
          signature = await provider.request({ method: "eth_signTypedData_v4", params: [wallet.address, JSON.stringify(info.typedData)] });
        } catch (e) {
          // MetaMask refuses to sign a delegation for its own accounts. No setting changes that.
          if (/cannot sign delegations|internal accounts/i.test(e instanceof Error ? e.message : String(e)))
            throw new Error("MetaMask does not let apps request permissions. Ask the agent to send the transactions to your wallet to sign, or link a wallet that signs permissions, such as Rabby.");
          throw e;
        }
        const granted = await post<Permission>(`/permissions/${id}/grant`, { signature });
        qc.invalidateQueries({ queryKey: ["permissions"] });
        return granted;
      } catch (e) {
        setError(short(e, "The permission was not granted"));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [external, connectWallet, qc],
  );

  const remove = useCallback(
    async (id: string) => {
      await api(`/permissions/${id}`, { method: "DELETE" });
      qc.invalidateQueries({ queryKey: ["permissions"] });
    },
    [qc],
  );

  return { link, unlink, grant, remove, busy, error };
}
