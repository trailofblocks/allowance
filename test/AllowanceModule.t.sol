// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {AllowanceModule} from "../contracts/AllowanceModule.sol";
import {AgentAccount} from "../contracts/AgentAccount.sol";
import {MockEIP3009Token} from "../contracts/mocks/MockEIP3009Token.sol";
import {Account as OZAccount} from "@openzeppelin/contracts/account/Account.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {MODULE_TYPE_EXECUTOR, MODULE_TYPE_VALIDATOR} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract AllowanceModuleTest is Base {
    bytes4 constant MAGIC = 0x1626ba7e;

    // ------------------------------------------------------------------ install and config

    function test_installAppliesConfig() public view {
        assertTrue(module.isModuleType(MODULE_TYPE_EXECUTOR));
        assertTrue(module.isModuleType(MODULE_TYPE_VALIDATOR));
        assertFalse(module.isModuleType(3));
        assertTrue(acct().isModuleInstalled(MODULE_TYPE_EXECUTOR, address(module), ""));
        assertTrue(acct().isModuleInstalled(MODULE_TYPE_VALIDATOR, address(module), ""));
        assertTrue(module.isInitialized(owner));
        assertTrue(module.isAgent(owner, agent));
        assertTrue(module.isRecipient(owner, vendor));
        assertFalse(module.isRecipient(owner, attacker));
        (address c, bool paused, uint32 ttl, uint32 window,) = module.settings(owner);
        assertEq(c, cosigner);
        assertFalse(paused);
        assertEq(ttl, 1 days);
        assertEq(window, 1 hours);
        (uint256 autoLeft, uint256 hardLeft, uint64 ends) = module.remaining(owner, address(token));
        assertEq(autoLeft, AUTO_PER_PERIOD);
        assertEq(hardLeft, MAX_PER_PERIOD);
        assertEq(ends, block.timestamp + PERIOD);
    }

    function test_typehashMatchesToken() public view {
        assertEq(module.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH());
    }

    function test_invalidLimitsRejected() public {
        AllowanceModule.TokenLimits memory l = defaultLimits();
        l.autoPerPeriod = MAX_PER_PERIOD + 1;
        vm.prank(owner);
        vm.expectRevert(AllowanceModule.InvalidLimits.selector);
        module.setTokenLimits(address(token), l);

        l = defaultLimits();
        l.cosignAbove = MAX_PER_TX + 1;
        vm.prank(owner);
        vm.expectRevert(AllowanceModule.InvalidLimits.selector);
        module.setTokenLimits(address(token), l);

        l = defaultLimits();
        vm.prank(owner);
        vm.expectRevert(AllowanceModule.InvalidLimits.selector);
        module.setTokenLimits(makeAddr("not-a-contract"), l);
    }

    function test_uninstallForgetsEverything() public {
        vm.prank(owner);
        acct().uninstallModule(MODULE_TYPE_EXECUTOR, address(module), "");
        assertFalse(module.isAgent(owner, agent));
        assertFalse(module.isRecipient(owner, vendor));
        assertFalse(module.isInitialized(owner));
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.NotAgent.selector, agent));
        pay(vendor, 1 * USDC);
    }

    // ------------------------------------------------------------------ pay: the happy path

    function test_payWithinAutoBudget() public {
        (bool paid, uint256 id) = pay(vendor, 40 * USDC);
        assertTrue(paid);
        assertEq(id, 0);
        assertEq(token.balanceOf(vendor), 40 * USDC);
        assertEq(token.balanceOf(owner), FUNDING - 40 * USDC);
        (uint256 autoLeft, uint256 hardLeft,) = module.remaining(owner, address(token));
        assertEq(autoLeft, AUTO_PER_PERIOD - 40 * USDC);
        assertEq(hardLeft, MAX_PER_PERIOD - 40 * USDC);
    }

    function test_payEmitsAuditEvent() public {
        vm.expectEmit(address(module));
        emit AllowanceModule.Paid(owner, address(token), vendor, 5 * USDC, agent, bytes32("ref"), false);
        pay(vendor, 5 * USDC);
    }

    function test_windowResetsAfterPeriod() public {
        pay(vendor, 100 * USDC);
        pay(vendor, 100 * USDC);
        (uint256 autoLeft,,) = module.remaining(owner, address(token));
        assertEq(autoLeft, 0);
        vm.warp(block.timestamp + PERIOD);
        (autoLeft,,) = module.remaining(owner, address(token));
        assertEq(autoLeft, AUTO_PER_PERIOD);
        (bool paid,) = pay(vendor, 100 * USDC);
        assertTrue(paid);
    }

    // ------------------------------------------------------------------ pay: rejections

    function test_onlyAgentsCanPay() public {
        for (uint256 i; i < 3; ++i) {
            address caller = [attacker, cosigner, owner][i];
            vm.prank(caller);
            vm.expectRevert(abi.encodeWithSelector(AllowanceModule.NotAgent.selector, caller));
            module.pay(owner, address(token), vendor, 1 * USDC, 0);
        }
    }

    function test_unlistedRecipientRejected() public {
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.RecipientNotAllowed.selector, attacker));
        pay(attacker, 1 * USDC);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_unconfiguredTokenRejected() public {
        MockEIP3009Token other = new MockEIP3009Token("Other", "OTH");
        other.mint(owner, 1_000 * USDC);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.TokenNotConfigured.selector, address(other)));
        module.pay(owner, address(other), vendor, 1 * USDC, 0);
    }

    function test_zeroAmountRejected() public {
        vm.expectRevert(AllowanceModule.ZeroAmount.selector);
        pay(vendor, 0);
    }

    function test_overPerTxRejectedEvenForCosign() public {
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.OverPerTxLimit.selector, MAX_PER_TX + 1, MAX_PER_TX));
        pay(vendor, MAX_PER_TX + 1);
    }

    function test_overPeriodRejected() public {
        // Fill the window with co-signed payments up to the hard cap.
        (, uint256 id1) = pay(vendor, 500 * USDC);
        vm.prank(cosigner);
        module.approve(owner, id1);
        (, uint256 id2) = pay(vendor, 500 * USDC);
        vm.prank(cosigner);
        module.approve(owner, id2);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.OverPeriodLimit.selector, 1, 0));
        pay(vendor, 1);
    }

    function test_pauseStopsPayments() public {
        vm.prank(cosigner);
        module.pause(owner);
        vm.expectRevert(AllowanceModule.IsPaused.selector);
        pay(vendor, 1 * USDC);
        // Only the account can unpause; the cosigner's "unpause" only touches its own (empty) state.
        vm.prank(cosigner);
        module.unpause();
        vm.expectRevert(AllowanceModule.IsPaused.selector);
        pay(vendor, 1 * USDC);
        asOwner(abi.encodeCall(AllowanceModule.unpause, ()));
        (bool paid,) = pay(vendor, 1 * USDC);
        assertTrue(paid);
    }

    function test_strangersCannotPause() public {
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.NotApprover.selector, attacker));
        module.pause(owner);
    }

    // ------------------------------------------------------------------ the agent can't change the policy

    function test_agentCannotEditTheAccountsPolicy() public {
        // Admin functions act on msg.sender's own state, so the agent only edits an empty policy of its own.
        vm.startPrank(agent);
        module.setRecipient(attacker, true);
        module.setAgent(agent, true);
        vm.stopPrank();
        assertFalse(module.isRecipient(owner, attacker));
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.RecipientNotAllowed.selector, attacker));
        pay(attacker, 1 * USDC);
    }

    function test_agentCannotDriveTheAccount() public {
        bytes memory call = abi.encodeCall(AllowanceModule.setRecipient, (attacker, true));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, agent));
        acct().execute(bytes32(0), abi.encodePacked(address(module), uint256(0), call));

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(OZAccount.AccountUnauthorized.selector, agent));
        acct().installModule(MODULE_TYPE_EXECUTOR, makeAddr("evil-module"), "");

        vm.prank(agent);
        vm.expectRevert();
        acct().executeFromExecutor(bytes32(0), abi.encodePacked(address(token), uint256(0), bytes("")));
    }

    function test_moduleNeverValidatesUserOps() public view {
        PackedUserOperation memory op;
        assertEq(module.validateUserOp(op, bytes32(0)), 1);
    }

    // ------------------------------------------------------------------ co-signature

    function test_singlePaymentAboveThresholdWaitsForCosigner() public {
        (bool paid, uint256 id) = pay(vendor, 150 * USDC);
        assertFalse(paid);
        assertEq(id, 1);
        assertEq(token.balanceOf(vendor), 0);
        AllowanceModule.Pending memory q = module.pendingRequest(owner, id);
        assertEq(uint8(q.kind), uint8(AllowanceModule.Kind.Transfer));
        assertEq(q.amount, 150 * USDC);
        assertEq(q.agent, agent);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.NotApprover.selector, attacker));
        module.approve(owner, id);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.NotApprover.selector, agent));
        module.approve(owner, id);

        vm.expectEmit(address(module));
        emit AllowanceModule.Paid(owner, address(token), vendor, 150 * USDC, agent, bytes32("ref"), true);
        vm.prank(cosigner);
        module.approve(owner, id);
        assertEq(token.balanceOf(vendor), 150 * USDC);

        vm.prank(cosigner);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.UnknownPending.selector, id));
        module.approve(owner, id);
    }

    function test_accountCanApproveToo() public {
        (, uint256 id) = pay(vendor, 150 * USDC);
        asOwner(abi.encodeCall(AllowanceModule.approve, (owner, id)));
        assertEq(token.balanceOf(vendor), 150 * USDC);
    }

    function test_splittingDoesNotDodgeTheCosigner() public {
        // 3 x 90 = 270: each is under cosignAbove (100), but the third crosses autoPerPeriod (200).
        (bool p1,) = pay(vendor, 90 * USDC);
        (bool p2,) = pay(vendor, 90 * USDC);
        (bool p3, uint256 id) = pay(vendor, 90 * USDC);
        assertTrue(p1 && p2);
        assertFalse(p3);
        assertGt(id, 0);
        assertEq(token.balanceOf(vendor), 180 * USDC);
    }

    function test_rejectDropsRequest() public {
        (, uint256 id) = pay(vendor, 150 * USDC);
        vm.prank(cosigner);
        module.reject(owner, id);
        vm.prank(cosigner);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.UnknownPending.selector, id));
        module.approve(owner, id);
        assertEq(token.balanceOf(vendor), 0);
    }

    function test_pendingExpires() public {
        (, uint256 id) = pay(vendor, 150 * USDC);
        vm.warp(block.timestamp + 1 days);
        vm.prank(cosigner);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.PendingExpired.selector, id));
        module.approve(owner, id);
    }

    function test_approvalRechecksPolicy() public {
        (, uint256 id) = pay(vendor, 150 * USDC);
        asOwner(abi.encodeCall(AllowanceModule.setRecipient, (vendor, false)));
        vm.prank(cosigner);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.RecipientNotAllowed.selector, vendor));
        module.approve(owner, id);
    }

    function test_removedAgentsRequestsDie() public {
        (, uint256 id) = pay(vendor, 150 * USDC);
        asOwner(abi.encodeCall(AllowanceModule.setAgent, (agent, false)));
        vm.prank(cosigner);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.NotAgent.selector, agent));
        module.approve(owner, id);
    }

    function test_hardCapHoldsWithCosign() public {
        AllowanceModule.TokenLimits memory l = defaultLimits();
        l.maxPerPeriod = 600 * 1e6;
        asOwner(abi.encodeCall(AllowanceModule.setTokenLimits, (address(token), l)));
        (, uint256 id1) = pay(vendor, 500 * USDC);
        vm.prank(cosigner);
        module.approve(owner, id1);
        // 500 + 150 > 600: rejected outright, not queued.
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.OverPeriodLimit.selector, 150 * USDC, 100 * USDC));
        pay(vendor, 150 * USDC);
    }

    // ------------------------------------------------------------------ fixed windows: the documented edge

    function test_boundaryAllowsTwiceTheLimitAcrossOnePeriodSpan() public {
        // Spend the whole auto budget one second before the window ends, then again one second after.
        vm.warp(block.timestamp + PERIOD - 1);
        pay(vendor, 100 * USDC);
        pay(vendor, 100 * USDC);
        vm.warp(block.timestamp + 2);
        pay(vendor, 100 * USDC);
        pay(vendor, 100 * USDC);
        // 2 x autoPerPeriod within 2 seconds. This is the documented worst case for fixed windows.
        assertEq(token.balanceOf(vendor), 2 * AUTO_PER_PERIOD);
        (bool paid,) = pay(vendor, 1);
        assertFalse(paid);
    }

    // ------------------------------------------------------------------ x402: reservations and ERC-1271

    function test_reservedAuthorizationSettles() public {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n1"));
        (bool ok, bytes32 digest,) = reserve(a);
        assertTrue(ok);
        assertEq(acct().isValidSignature(digest, abi.encodePacked(address(module))), MAGIC);
        (uint256 autoLeft,,) = module.remaining(owner, address(token));
        assertEq(autoLeft, AUTO_PER_PERIOD - 25 * USDC);

        settle(a);
        assertEq(token.balanceOf(vendor), 25 * USDC);
        assertTrue(token.authorizationState(owner, a.nonce));

        // Replaying the same authorization fails at the token.
        vm.expectRevert(MockEIP3009Token.AuthorizationAlreadyUsed.selector);
        settle(a);
    }

    function test_digestMatchesTheTokensOwnHash() public view {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n1"));
        bytes32 structHash = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), owner, a.to, a.value, a.validAfter, a.validBefore, a.nonce
            )
        );
        bytes32 expected = MessageHashUtils.toTypedDataHash(token.DOMAIN_SEPARATOR(), structHash);
        assertEq(module.authorizationDigest(owner, a.token, a.to, a.value, a.validAfter, a.validBefore, a.nonce), expected);
    }

    function test_unreservedAuthorizationIsRejected() public {
        AllowanceModule.Authorization memory a = auth(attacker, 25 * USDC, keccak256("forged"));
        vm.prank(facilitator);
        vm.expectRevert(MockEIP3009Token.InvalidSignature.selector);
        token.transferWithAuthorization(
            owner, a.to, a.value, a.validAfter, a.validBefore, a.nonce, abi.encodePacked(address(module))
        );
    }

    function test_alteredAuthorizationIsRejected() public {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n1"));
        reserve(a);
        // Same reservation, but the facilitator (or anyone) tries a different recipient or amount.
        AllowanceModule.Authorization memory b = a;
        b.to = attacker;
        vm.expectRevert(MockEIP3009Token.InvalidSignature.selector);
        settle(b);
        b = a;
        b.value = 250 * USDC;
        vm.expectRevert(MockEIP3009Token.InvalidSignature.selector);
        settle(b);
    }

    function test_agentKeySignatureIsWorthless() public {
        // A fooled agent signs an EIP-3009 authorization to the attacker with its own key.
        AllowanceModule.Authorization memory a = auth(attacker, 25 * USDC, keccak256("phish"));
        bytes32 digest = module.authorizationDigest(owner, a.token, a.to, a.value, a.validAfter, a.validBefore, a.nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        vm.expectRevert(MockEIP3009Token.InvalidSignature.selector);
        token.transferWithAuthorization(owner, a.to, a.value, a.validAfter, a.validBefore, a.nonce, v, r, s);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_ownerKeyStillSigns() public view {
        AllowanceModule.Authorization memory a = auth(attacker, 25 * USDC, keccak256("owner"));
        bytes32 digest = module.authorizationDigest(owner, a.token, a.to, a.value, a.validAfter, a.validBefore, a.nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, digest);
        assertEq(acct().isValidSignature(digest, abi.encodePacked(r, s, v)), MAGIC);
    }

    function test_reserveToUnlistedRecipientRejected() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.RecipientNotAllowed.selector, attacker));
        module.reserve(owner, auth(attacker, 25 * USDC, keccak256("n")), 0);
    }

    function test_reserveValidityBounds() public {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n"));
        a.validBefore = block.timestamp + 2 hours; // beyond maxAuthWindow
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.BadValidity.selector, a.validAfter, a.validBefore));
        module.reserve(owner, a, 0);

        a.validBefore = block.timestamp; // already expired
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.BadValidity.selector, a.validAfter, a.validBefore));
        module.reserve(owner, a, 0);
    }

    function test_reserveTwiceRejected() public {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n"));
        (, bytes32 digest,) = reserve(a);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.ReservationExists.selector, digest));
        module.reserve(owner, a, 0);
    }

    function test_reserveUsedNonceRejected() public {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n"));
        reserve(a);
        settle(a);
        AllowanceModule.Authorization memory b = auth(vendor, 26 * USDC, a.nonce);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.NonceUsed.selector, a.nonce));
        module.reserve(owner, b, 0);
    }

    function test_expiredReservationStopsValidating() public {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n"));
        (, bytes32 digest,) = reserve(a);
        vm.warp(a.validBefore);
        assertEq(acct().isValidSignature(digest, abi.encodePacked(address(module))), bytes4(0xffffffff));
    }

    function test_pauseRevokesOutstandingReservations() public {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n"));
        reserve(a);
        vm.prank(cosigner);
        module.pause(owner);
        vm.expectRevert(MockEIP3009Token.InvalidSignature.selector);
        settle(a);
    }

    function test_revokingRecipientAgentOrTokenRevokesReservations() public {
        bytes memory sig = abi.encodePacked(address(module));
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("r1"));
        (, bytes32 d1,) = reserve(a);
        asOwner(abi.encodeCall(AllowanceModule.setRecipient, (vendor, false)));
        assertEq(acct().isValidSignature(d1, sig), bytes4(0xffffffff));
        vm.expectRevert(MockEIP3009Token.InvalidSignature.selector);
        settle(a);
        asOwner(abi.encodeCall(AllowanceModule.setRecipient, (vendor, true)));
        assertEq(acct().isValidSignature(d1, sig), MAGIC);

        asOwner(abi.encodeCall(AllowanceModule.setAgent, (agent, false)));
        assertEq(acct().isValidSignature(d1, sig), bytes4(0xffffffff));
        asOwner(abi.encodeCall(AllowanceModule.setAgent, (agent, true)));

        AllowanceModule.TokenLimits memory off;
        asOwner(abi.encodeCall(AllowanceModule.setTokenLimits, (address(token), off)));
        assertEq(acct().isValidSignature(d1, sig), bytes4(0xffffffff));
    }

    function test_releaseRefundsUnusedReservation() public {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n"));
        (, bytes32 digest,) = reserve(a);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.ReservationLive.selector, digest));
        module.release(owner, digest);

        vm.warp(a.validBefore);
        vm.prank(attacker); // anyone may release
        uint256 refunded = module.release(owner, digest);
        assertEq(refunded, 25 * USDC);
        (uint256 autoLeft,,) = module.remaining(owner, address(token));
        assertEq(autoLeft, AUTO_PER_PERIOD);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.UnknownReservation.selector, digest));
        module.release(owner, digest);
    }

    function test_releaseAfterUseRefundsNothing() public {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n"));
        (, bytes32 digest,) = reserve(a);
        settle(a);
        assertEq(module.release(owner, digest), 0);
        (uint256 autoLeft,,) = module.remaining(owner, address(token));
        assertEq(autoLeft, AUTO_PER_PERIOD - 25 * USDC);
    }

    function test_releaseInLaterWindowRefundsNothing() public {
        AllowanceModule.Authorization memory a = auth(vendor, 25 * USDC, keccak256("n"));
        (, bytes32 digest,) = reserve(a);
        vm.warp(block.timestamp + PERIOD);
        assertEq(module.release(owner, digest), 0);
    }

    function test_largeReservationWaitsForCosigner() public {
        AllowanceModule.Authorization memory a = auth(vendor, 150 * USDC, keccak256("big"));
        (bool ok, bytes32 digest, uint256 id) = reserve(a);
        assertFalse(ok);
        assertEq(acct().isValidSignature(digest, abi.encodePacked(address(module))), bytes4(0xffffffff));
        vm.prank(cosigner);
        module.approve(owner, id);
        assertEq(acct().isValidSignature(digest, abi.encodePacked(address(module))), MAGIC);
        settle(a);
        assertEq(token.balanceOf(vendor), 150 * USDC);
    }

    function test_reservationsAndPaymentsShareTheWindow() public {
        reserve(auth(vendor, 100 * USDC, keccak256("a")));
        (bool paid,) = pay(vendor, 100 * USDC);
        assertTrue(paid);
        // The window is at autoPerPeriod now, so the next reservation needs the co-signer.
        (bool ok,,) = reserve(auth(vendor, 1, keccak256("b")));
        assertFalse(ok);
    }
}

/// @dev The module also works with an ordinary (non-7702) ERC-7579 contract account.
contract PlainAccountTest is Base {
    function test_plainContractAccount() public {
        AgentAccount plain = new AgentAccount();
        vm.prank(address(plain));
        plain.installModule(MODULE_TYPE_EXECUTOR, address(module), abi.encode(defaultConfig()));
        vm.prank(address(plain));
        plain.installModule(MODULE_TYPE_VALIDATOR, address(module), "");
        token.mint(address(plain), 1_000 * USDC);

        vm.prank(agent);
        (bool paid,) = module.pay(address(plain), address(token), vendor, 10 * USDC, 0);
        assertTrue(paid);
        assertEq(token.balanceOf(vendor), 10 * USDC);

        AllowanceModule.Authorization memory a = auth(vendor, 5 * USDC, keccak256("p"));
        vm.prank(agent);
        module.reserve(address(plain), a, 0);
        vm.prank(facilitator);
        token.transferWithAuthorization(
            address(plain), a.to, a.value, a.validAfter, a.validBefore, a.nonce, abi.encodePacked(address(module))
        );
        assertEq(token.balanceOf(vendor), 15 * USDC);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.RecipientNotAllowed.selector, attacker));
        module.pay(address(plain), address(token), attacker, 1, 0);
    }
}
