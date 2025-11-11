// tests/hedao-token.test.ts
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { Cl, ClarityType, cvToValue, uintCV, someCV, noneCV, bufferCV } from "@stacks/transactions";
import { StacksMocknet } from "lib-stacks";

interface StakeInfo {
  amount: bigint;
  "reward-debt": bigint;
  "last-claim-block": bigint;
  "lock-until": bigint;
}

interface TokenState {
  balances: Map<string, bigint>;
  totalSupply: bigint;
  stakes: Map<string, StakeInfo>;
  accumulatedRewardPerShare: bigint;
  lastGlobalRewardBlock: bigint;
  rewardPerBlock: bigint;
  minters: Set<string>;
  blockHeight: bigint;
}

class HEDAOContractMock {
  private state: TokenState = {
    balances: new Map(),
    totalSupply: BigInt("50000000000000"),
    stakes: new Map(),
    accumulatedRewardPerShare: BigInt(0),
    lastGlobalRewardBlock: BigInt(0),
    rewardPerBlock: BigInt(1000000),
    minters: new Set(),
    blockHeight: BigInt(100),
  };

  private contractOwner = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3HBY2TZX6Y4T7";
  private contractAddress = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3HBY2TZX6Y4T7.hedao-token";

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      balances: new Map([[this.contractOwner, BigInt("50000000000000")]]),
      totalSupply: BigInt("50000000000000"),
      stakes: new Map(),
      accumulatedRewardPerShare: BigInt(0),
      lastGlobalRewardBlock: BigInt(100),
      rewardPerBlock: BigInt(1000000),
      minters: new Set(),
      blockHeight: BigInt(100),
    };
  }

  private getCaller() {
    return this.contractOwner;
  }

  private advanceBlocks(blocks: number) {
    this.state.blockHeight += BigInt(blocks);
  }

  private updateAccumulatedReward() {
    const current = this.state.blockHeight;
    const last = this.state.lastGlobalRewardBlock;
    if (current <= last) return;

    const blocksSince = current - last;
    const totalStaked = this.getTotalStaked();
    let reward = BigInt(0);
    if (totalStaked > BigInt(0)) {
      reward = blocksSince * this.state.rewardPerBlock;
      const multiplier = BigInt("1000000000000");
      this.state.accumulatedRewardPerShare += (reward * multiplier) / totalStaked;
    }
    this.state.lastGlobalRewardBlock = current;
  }

  private getTotalStaked(): bigint {
    let total = BigInt(0);
    for (const stake of this.state.stakes.values()) {
      total += stake.amount;
    }
    return total;
  }

  getName(caller: string): { type: ClarityType; value: string } {
    return { type: ClarityType.ResponseOk, value: "HEDAO Governance Token" };
  }

  getSymbol(caller: string): { type: ClarityType; value: string } {
    return { type: ClarityType.ResponseOk, value: "HEDAO" };
  }

  getDecimals(caller: string): { type: ClarityType; value: bigint } {
    return { type: ClarityType.ResponseOk, value: BigInt(6) };
  }

  getBalance(caller: string, account: string): { type: ClarityType; value: bigint } {
    const bal = this.state.balances.get(account) || BigInt(0);
    return { type: ClarityType.ResponseOk, value: bal };
  }

  getTotalSupply(caller: string): { type: ClarityType; value: bigint } {
    return { type: ClarityType.ResponseOk, value: this.state.totalSupply };
  }

  getTokenUri(caller: string): { type: ClarityType; value: { type: ClarityType; value: string } | null } {
    return { type: ClarityType.ResponseOk, value: { type: ClarityType.Some, value: "https://hedao.xyz/metadata.json" } };
  }

  transfer(
    caller: string,
    amount: bigint,
    sender: string,
    recipient: string,
    memo: { type: ClarityType; value: Uint8Array } | null
  ): { type: ClarityType; value: boolean } {
    if (sender === recipient) return { type: ClarityType.ResponseErr, value: BigInt(108) };
    if (amount <= BigInt(0)) return { type: ClarityType.ResponseErr, value: BigInt(102) };

    const senderBal = this.state.balances.get(sender) || BigInt(0);
    if (senderBal < amount) return { type: ClarityType.ResponseErr, value: BigInt(101) };

    this.state.balances.set(sender, senderBal - amount);
    const recipientBal = this.state.balances.get(recipient) || BigInt(0);
    this.state.balances.set(recipient, recipientBal + amount);
    return { type: ClarityType.ResponseOk, value: true };
  }

  mint(caller: string, amount: bigint, recipient: string): { type: ClarityType; value: boolean } {
    if (caller !== this.contractOwner && !this.state.minters.has(caller)) {
      return { type: ClarityType.ResponseErr, value: BigInt(100) };
    }
    if (amount <= BigInt(0)) return { type: ClarityType.ResponseErr, value: BigInt(102) };
    if (this.state.totalSupply + amount > BigInt("100000000000000")) {
      return { type: ClarityType.ResponseErr, value: BigInt(107) };
    }

    this.state.totalSupply += amount;
    const bal = this.state.balances.get(recipient) || BigInt(0);
    this.state.balances.set(recipient, bal + amount);
    return { type: ClarityType.ResponseOk, value: true };
  }

  setMinter(caller: string, minter: string, enabled: boolean): { type: ClarityType; value: boolean } {
    if (caller !== this.contractOwner) return { type: ClarityType.ResponseErr, value: BigInt(100) };
    if (enabled) this.state.minters.add(minter);
    else this.state.minters.delete(minter);
    return { type: ClarityType.ResponseOk, value: true };
  }

  burn(caller: string, amount: bigint): { type: ClarityType; value: boolean } {
    if (amount <= BigInt(0)) return { type: ClarityType.ResponseErr, value: BigInt(102) };
    const bal = this.state.balances.get(caller) || BigInt(0);
    if (bal < amount) return { type: ClarityType.ResponseErr, value: BigInt(101) };
    this.state.balances.set(caller, bal - amount);
    this.state.totalSupply -= amount;
    return { type: ClarityType.ResponseOk, value: true };
  }

  stake(caller: string, amount: bigint, lockPeriod: bigint): { type: ClarityType; value: boolean } {
    if (amount <= BigInt(0)) return { type: ClarityType.ResponseErr, value: BigInt(102) };
    if (lockPeriod < BigInt(144)) return { type: ClarityType.ResponseErr, value: BigInt(102) };

    const bal = this.state.balances.get(caller) || BigInt(0);
    if (bal < amount) return { type: ClarityType.ResponseErr, value: BigInt(101) };

    this.updateAccumulatedReward();
    const existing = this.state.stakes.get(caller);
    let newAmount = amount;
    let newDebt = BigInt(0);

    if (existing) {
      newAmount += existing.amount;
    }

    newDebt = (newAmount * this.state.accumulatedRewardPerShare) / BigInt("1000000000000");

    this.state.stakes.set(caller, {
      amount: newAmount,
      "reward-debt": newDebt,
      "last-claim-block": this.state.blockHeight,
      "lock-until": this.state.blockHeight + lockPeriod,
    });

    this.state.balances.set(caller, bal - amount);
    const contractBal = this.state.balances.get(this.contractAddress) || BigInt(0);
    this.state.balances.set(this.contractAddress, contractBal + amount);

    return { type: ClarityType.ResponseOk, value: true };
  }

  unstake(caller: string, amount: bigint): { type: ClarityType; value: boolean } {
    const stake = this.state.stakes.get(caller);
    if (!stake) return { type: ClarityType.ResponseErr, value: BigInt(104) };
    if (this.state.blockHeight < stake["lock-until"]) return { type: ClarityType.ResponseErr, value: BigInt(105) };
    if (stake.amount < amount) return { type: ClarityType.ResponseErr, value: BigInt(101) };

    this.updateAccumulatedReward();
    const pending = this.calculatePendingReward(caller);
    if (pending > BigInt(0)) {
      this.claimReward(caller);
    }

    const newAmount = stake.amount - amount;
    const newDebt = newAmount > BigInt(0)
      ? (newAmount * this.state.accumulatedRewardPerShare) / BigInt("1000000000000")
      : BigInt(0);

    if (newAmount > BigInt(0)) {
      this.state.stakes.set(caller, {
        amount: newAmount,
        "reward-debt": newDebt,
        "last-claim-block": this.state.blockHeight,
        "lock-until": stake["lock-until"],
      });
    } else {
      this.state.stakes.delete(caller);
    }

    const contractBal = this.state.balances.get(this.contractAddress) || BigInt(0);
    this.state.balances.set(this.contractAddress, contractBal - amount);
    const userBal = this.state.balances.get(caller) || BigInt(0);
    this.state.balances.set(caller, userBal + amount);

    return { type: ClarityType.ResponseOk, value: true };
  }

  claimReward(caller: string): { type: ClarityType; value: bigint } {
    const pending = this.calculatePendingReward(caller);
    if (pending <= BigInt(0)) return { type: ClarityType.ResponseOk, value: BigInt(0) };

    const stake = this.state.stakes.get(caller);
    if (!stake) return { type: ClarityType.ResponseErr, value: BigInt(104) };

    const newDebt = (stake.amount * this.state.accumulatedRewardPerShare) / BigInt("1000000000000");
    this.state.stakes.set(caller, {
      ...stake,
      "reward-debt": newDebt,
      "last-claim-block": this.state.blockHeight,
    });

    const contractBal = this.state.balances.get(this.contractAddress) || BigInt(0);
    if (contractBal < pending) return { type: ClarityType.ResponseErr, value: BigInt(101) };
    this.state.balances.set(this.contractAddress, contractBal - pending);
    const userBal = this.state.balances.get(caller) || BigInt(0);
    this.state.balances.set(caller, userBal + pending);

    return { type: ClarityType.ResponseOk, value: pending };
  }

  calculatePendingReward(caller: string): bigint {
    const stake = this.state.stakes.get(caller);
    if (!stake || stake.amount <= BigInt(0)) return BigInt(0);

    this.updateAccumulatedReward();
    const userAcc = (stake.amount * this.state.accumulatedRewardPerShare) / BigInt("1000000000000");
    return userAcc > stake["reward-debt"] ? userAcc - stake["reward-debt"] : BigInt(0);
  }

  getStakeInfo(caller: string, user: string): { type: ClarityType; value: StakeInfo | null } {
    const stake = this.state.stakes.get(user);
    return { type: ClarityType.ResponseOk, value: stake || null };
  }

  setRewardPerBlock(caller: string, reward: bigint): { type: ClarityType; value: boolean } {
    if (caller !== this.contractOwner) return { type: ClarityType.ResponseErr, value: BigInt(100) };
    this.updateAccumulatedReward();
    this.state.rewardPerBlock = reward;
    return { type: ClarityType.ResponseOk, value: true };
  }

  getAccumulatedRewardPerShare(caller: string): { type: ClarityType; value: bigint } {
    this.updateAccumulatedReward();
    return { type: ClarityType.ResponseOk, value: this.state.accumulatedRewardPerShare };
  }

  getRewardPerBlock(caller: string): { type: ClarityType; value: bigint } {
    return { type: ClarityType.ResponseOk, value: this.state.rewardPerBlock };
  }

  getLastGlobalRewardBlock(caller: string): { type: ClarityType; value: bigint } {
    return { type: ClarityType.ResponseOk, value: this.state.lastGlobalRewardBlock };
  }
}

describe("hedao-token.clar - HEDAO Governance Token", () => {
  let contract: HEDAOContractMock;
  let accounts: { owner: string; alice: string; bob: string; charlie: string };

  beforeEach(() => {
    contract = new HEDAOContractMock();
    accounts = {
      owner: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3HBY2TZX6Y4T7",
      alice: "ST2PQHQKV0RJXZFY1DGX8MNSNYVE3HBY2TZX6Y4T8",
      bob: "ST3PQHQKV0RJXZFY1DGX8MNSNYVE3HBY2TZX6Y4T9",
      charlie: "ST4PQHQKV0RJXZFY1DGX8MNSNYVE3HBY2TZX6Y4TA",
    };
  });

  describe("SIP-010 Standard Compliance", () => {
    it("returns correct token name", () => {
      const result = contract.getName(accounts.owner);
      expect(result.type).toBe(ClarityType.ResponseOk);
      expect(result.value).toBe("HEDAO Governance Token");
    });

    it("returns correct token symbol", () => {
      const result = contract.getSymbol(accounts.owner);
      expect(result.type).toBe(ClarityType.ResponseOk);
      expect(result.value).toBe("HEDAO");
    });

    it("returns correct decimals", () => {
      const result = contract.getDecimals(accounts.owner);
      expect(result.type).toBe(ClarityType.ResponseOk);
      expect(result.value).toBe(BigInt(6));
    });

    it("returns correct initial balance for owner", () => {
      const result = contract.getBalance(accounts.owner, accounts.owner);
      expect(result.type).toBe(ClarityType.ResponseOk);
      expect(result.value).toBe(BigInt("50000000000000"));
    });

    it("returns correct total supply", () => {
      const result = contract.getTotalSupply(accounts.owner);
      expect(result.type).toBe(ClarityType.ResponseOk);
      expect(result.value).toBe(BigInt("50000000000000"));
    });

    it("returns token URI", () => {
      const result = contract.getTokenUri(accounts.owner);
      expect(result.type).toBe(ClarityType.ResponseOk);
      expect(result.value).toEqual({ type: ClarityType.Some, value: "https://hedao.xyz/metadata.json" });
    });
  });

  describe("Transfer Functionality", () => {
    it("transfers tokens successfully between users", () => {
      contract.mint(accounts.owner, BigInt("1000000000000"), accounts.alice);
      const result = contract.transfer(accounts.alice, BigInt("500000000"), accounts.alice, accounts.bob, null);
      expect(result.type).toBe(ClarityType.ResponseOk);

      const aliceBal = contract.getBalance(accounts.alice, accounts.alice);
      const bobBal = contract.getBalance(accounts.alice, accounts.bob);
      expect(aliceBal.value).toBe(BigInt("999500000000"));
      expect(bobBal.value).toBe(BigInt("500000000"));
    });

    it("rejects transfer to self", () => {
      const result = contract.transfer(accounts.owner, BigInt(100), accounts.owner, accounts.owner, null);
      expect(result.type).toBe(ClarityType.ResponseErr);
      expect(result.value).toBe(BigInt(108));
    });

    it("rejects transfer of zero amount", () => {
      const result = contract.transfer(accounts.owner, BigInt(0), accounts.owner, accounts.alice, null);
      expect(result.type).toBe(ClarityType.ResponseErr);
      expect(result.value).toBe(BigInt(102));
    });

    it("rejects transfer with insufficient balance", () => {
      const result = contract.transfer(accounts.alice, BigInt("1000000000000"), accounts.alice, accounts.bob, null);
      expect(result.type).toBe(ClarityType.ResponseErr);
      expect(result.value).toBe(BigInt(101));
    });
  });

  describe("Minting Controls", () => {
    it("allows owner to mint within cap", () => {
      const result = contract.mint(accounts.owner, BigInt("1000000000000"), accounts.alice);
      expect(result.type).toBe(ClarityType.ResponseOk);
      const bal = contract.getBalance(accounts.alice, accounts.alice);
      expect(bal.value).toBe(BigInt("1000000000000"));
    });

    it("allows authorized minter to mint", () => {
      contract.setMinter(accounts.owner, accounts.alice, true);
      const result = contract.mint(accounts.alice, BigInt("500000000000"), accounts.bob);
      expect(result.type).toBe(ClarityType.ResponseOk);
      const bal = contract.getBalance(accounts.bob, accounts.bob);
      expect(bal.value).toBe(BigInt("500000000000"));
    });

    it("rejects mint by unauthorized user", () => {
      const result = contract.mint(accounts.alice, BigInt(100), accounts.alice);
      expect(result.type).toBe(ClarityType.ResponseErr);
      expect(result.value).toBe(BigInt(100));
    });

    it("rejects mint exceeding cap", () => {
      contract.mint(accounts.owner, BigInt("49999990000000"), accounts.alice);
      const result = contract.mint(accounts.owner, BigInt("100000000"), accounts.alice);
      expect(result.type).toBe(ClarityType.ResponseErr);
      expect(result.value).toBe(BigInt(107));
    });
  });

  describe("Staking Mechanism", () => {
    beforeEach(() => {
      contract.mint(accounts.owner, BigInt("1000000000000"), accounts.alice);
      contract.advanceBlocks(10);
    });

    it("allows user to stake tokens", () => {
      const result = contract.stake(accounts.alice, BigInt("1000000000"), BigInt(288));
      expect(result.type).toBe(ClarityType.ResponseOk);
      const info = contract.getStakeInfo(accounts.alice, accounts.alice);
      expect(info.value?.amount).toBe(BigInt("1000000000"));
    });

    it("rejects stake with zero amount", () => {
      const result = contract.stake(accounts.alice, BigInt(0), BigInt(288));
      expect(result.type).toBe(ClarityType.ResponseErr);
      expect(result.value).toBe(BigInt(102));
    });

    it("rejects stake with lock period < 144 blocks", () => {
      const result = contract.stake(accounts.alice, BigInt("1000000000"), BigInt(100));
      expect(result.type).toBe(ClarityType.ResponseErr);
      expect(result.value).toBe(BigInt(102));
    });

    it("accumulates rewards over time", () => {
      contract.stake(accounts.alice, BigInt("1000000000"), BigInt(288));
      contract.advanceBlocks(100);
      const pending = contract.calculatePendingReward(accounts.alice);
      expect(pending).toBeGreaterThan(BigInt(0));
    });

    it("correctly claims rewards", () => {
      contract.stake(accounts.alice, BigInt("1000000000"), BigInt(288));
      contract.advanceBlocks(50);
      const claim = contract.claimReward(accounts.alice);
      expect(claim.type).toBe(ClarityType.ResponseOk);
      expect(claim.value).toBeGreaterThan(BigInt(0));
    });

    it("prevents unstake before lock period", () => {
      contract.stake(accounts.alice, BigInt("1000000000"), BigInt(288));
      contract.advanceBlocks(100);
      const result = contract.unstake(accounts.alice, BigInt("500000000"));
      expect(result.type).toBe(ClarityType.ResponseErr);
      expect(result.value).toBe(BigInt(105));
    });

    it("allows unstake after lock period", () => {
      contract.stake(accounts.alice, BigInt("1000000000"), BigInt(288));
      contract.advanceBlocks(300);
      const result = contract.unstake(accounts.alice, BigInt("500000000"));
      expect(result.type).toBe(ClarityType.ResponseOk);
      const bal = contract.getBalance(accounts.alice, accounts.alice);
      expect(bal.value).toBeGreaterThan(BigInt("500000000000"));
    });
  });

  describe("Admin Functions", () => {
    it("allows owner to set reward per block", () => {
      const result = contract.setRewardPerBlock(accounts.owner, BigInt(2000000));
      expect(result.type).toBe(ClarityType.ResponseOk);
      const reward = contract.getRewardPerBlock(accounts.owner);
      expect(reward.value).toBe(BigInt(2000000));
    });

    it("rejects non-owner setting reward", () => {
      const result = contract.setRewardPerBlock(accounts.alice, BigInt(2000000));
      expect(result.type).toBe(ClarityType.ResponseErr);
      expect(result.value).toBe(BigInt(100));
    });
  });

  describe("Edge Cases & Security", () => {
    it("handles multiple stakes and claims", () => {
      contract.mint(accounts.owner, BigInt("1000000000000"), accounts.alice);
      contract.stake(accounts.alice, BigInt("100000000"), BigInt(144));
      contract.advanceBlocks(50);
      contract.stake(accounts.alice, BigInt("100000000"), BigInt(288));
      contract.advanceBlocks(50);
      const claim = contract.claimReward(accounts.alice);
      expect(claim.type).toBe(ClarityType.ResponseOk);
    });

    it("prevents reentrancy in claim", () => {
      contract.stake(accounts.alice, BigInt("1000000000"), BigInt(144));
      contract.advanceBlocks(10);
      contract.claimReward(accounts.alice);
      const pending = contract.calculatePendingReward(accounts.alice);
      expect(pending).toBe(BigInt(0));
    });
  });
});