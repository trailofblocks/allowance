// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AllowanceModule} from "../contracts/AllowanceModule.sol";
import {AgentAccount} from "../contracts/AgentAccount.sol";
import {MockEIP3009Token} from "../contracts/mocks/MockEIP3009Token.sol";
import {MODULE_TYPE_EXECUTOR, MODULE_TYPE_VALIDATOR} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";

/// @dev Shared setup: an EOA upgraded to AgentAccount with EIP-7702, with the module installed both ways.
abstract contract Base is Test {
    uint256 internal constant USDC = 1e6;
    uint64 internal constant PERIOD = 1 days;
    uint128 internal constant MAX_PER_TX = 500 * 1e6;
    uint128 internal constant COSIGN_ABOVE = 100 * 1e6;
    uint128 internal constant AUTO_PER_PERIOD = 200 * 1e6;
    uint128 internal constant MAX_PER_PERIOD = 1_000 * 1e6;
    uint256 internal constant FUNDING = 10_000 * 1e6;

    AllowanceModule internal module;
    MockEIP3009Token internal token;
    AgentAccount internal impl;

    uint256 internal ownerPk = 0xA11CE;
    uint256 internal agentPk = 0xA6E47;
    address internal owner; // the EOA, which is also the account
    address internal agent;
    address internal cosigner = makeAddr("cosigner");
    address internal vendor = makeAddr("vendor");
    address internal vendor2 = makeAddr("vendor2");
    address internal attacker = makeAddr("attacker");
    address internal facilitator = makeAddr("facilitator");

    function setUp() public virtual {
        vm.warp(1_750_000_000);
        owner = vm.addr(ownerPk);
        agent = vm.addr(agentPk);
        module = new AllowanceModule();
        token = new MockEIP3009Token("Mock USDC", "mUSDC");
        impl = new AgentAccount();

        // EIP-7702: the owner's EOA now runs AgentAccount's code.
        vm.signAndAttachDelegation(address(impl), ownerPk);
        vm.prank(owner);
        acct().installModule(MODULE_TYPE_EXECUTOR, address(module), abi.encode(defaultConfig()));
        vm.prank(owner);
        acct().installModule(MODULE_TYPE_VALIDATOR, address(module), "");

        token.mint(owner, FUNDING);
    }

    function acct() internal view returns (AgentAccount) {
        return AgentAccount(payable(owner));
    }

    function defaultLimits() internal pure returns (AllowanceModule.TokenLimits memory) {
        return AllowanceModule.TokenLimits({
            maxPerTx: MAX_PER_TX,
            cosignAbove: COSIGN_ABOVE,
            autoPerPeriod: AUTO_PER_PERIOD,
            maxPerPeriod: MAX_PER_PERIOD,
            period: PERIOD
        });
    }

    function defaultConfig() internal view returns (AllowanceModule.InitConfig memory cfg) {
        cfg.agents = new address[](1);
        cfg.agents[0] = agent;
        cfg.cosigner = cosigner;
        cfg.recipients = new address[](2);
        cfg.recipients[0] = vendor;
        cfg.recipients[1] = vendor2;
        cfg.tokens = new AllowanceModule.TokenInit[](1);
        cfg.tokens[0] = AllowanceModule.TokenInit(address(token), defaultLimits());
        cfg.pendingTtl = 1 days;
        cfg.maxAuthWindow = 1 hours;
    }

    /// @dev Run a call to the module as the account, the way the owner would: a self-call to `execute`.
    function asOwner(bytes memory moduleCall) internal {
        vm.prank(owner);
        acct().execute(bytes32(0), abi.encodePacked(address(module), uint256(0), moduleCall));
    }

    function pay(address to, uint256 amount) internal returns (bool paid, uint256 id) {
        vm.prank(agent);
        return module.pay(owner, address(token), to, amount, bytes32("ref"));
    }

    function auth(address to, uint256 value, bytes32 nonce)
        internal
        view
        returns (AllowanceModule.Authorization memory)
    {
        return AllowanceModule.Authorization({
            token: address(token),
            to: to,
            value: value,
            validAfter: block.timestamp - 600,
            validBefore: block.timestamp + 300,
            nonce: nonce
        });
    }

    function reserve(AllowanceModule.Authorization memory a) internal returns (bool ok, bytes32 digest, uint256 id) {
        vm.prank(agent);
        return module.reserve(owner, a, bytes32("x402"));
    }

    /// @dev What an x402 facilitator does to settle: call the token with the account's "signature",
    /// which is just the validator's address (the reservation is the authorization).
    function settle(AllowanceModule.Authorization memory a) internal {
        vm.prank(facilitator);
        token.transferWithAuthorization(
            owner, a.to, a.value, a.validAfter, a.validBefore, a.nonce, abi.encodePacked(address(module))
        );
    }
}
