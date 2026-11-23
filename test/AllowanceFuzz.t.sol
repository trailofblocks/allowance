// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {AllowanceModule} from "../contracts/AllowanceModule.sol";
import {MockEIP3009Token} from "../contracts/mocks/MockEIP3009Token.sol";

/// @dev Fuzz tests. The first one replays random payment sequences against a small reference model.
contract AllowanceFuzzTest is Base {
    // Reference model of one token's window.
    uint256 internal mWindow;
    uint256 internal mSpent;
    uint256 internal mAnchor;

    function setUp() public override {
        super.setUp();
        mAnchor = block.timestamp;
    }

    function testFuzz_payMatchesReferenceModel(
        uint256[12] memory amounts,
        uint32[12] memory gaps,
        bool[12] memory toAttacker,
        bool[12] memory cosignerSaysYes
    ) public {
        uint256 paidOut;
        for (uint256 i; i < 12; ++i) {
            vm.warp(block.timestamp + bound(gaps[i], 0, 2 * PERIOD));
            uint256 amount = bound(amounts[i], 0, 600 * USDC);
            address to = toAttacker[i] ? attacker : vendor;

            bytes memory expectedError;
            if (to != vendor) {
                expectedError = abi.encodeWithSelector(AllowanceModule.RecipientNotAllowed.selector, to);
            } else if (amount == 0) {
                expectedError = abi.encodeWithSelector(AllowanceModule.ZeroAmount.selector);
            } else if (amount > MAX_PER_TX) {
                expectedError = abi.encodeWithSelector(AllowanceModule.OverPerTxLimit.selector, amount, MAX_PER_TX);
            } else {
                uint256 w = (block.timestamp - mAnchor) / PERIOD;
                if (w != mWindow) {
                    mWindow = w;
                    mSpent = 0;
                }
                if (amount > MAX_PER_PERIOD - mSpent) {
                    expectedError =
                        abi.encodeWithSelector(AllowanceModule.OverPeriodLimit.selector, amount, MAX_PER_PERIOD - mSpent);
                }
            }

            if (expectedError.length != 0) {
                vm.expectRevert(expectedError);
                pay(to, amount);
                continue;
            }

            bool needsCosign = amount > COSIGN_ABOVE || mSpent + amount > AUTO_PER_PERIOD;
            (bool paid, uint256 id) = pay(to, amount);
            assertEq(paid, !needsCosign, "co-signature decision");
            if (needsCosign) {
                if (!cosignerSaysYes[i]) continue;
                vm.prank(cosigner);
                module.approve(owner, id);
            }
            mSpent += amount;
            paidOut += amount;

            (uint256 autoLeft, uint256 hardLeft,) = module.remaining(owner, address(token));
            assertEq(hardLeft, MAX_PER_PERIOD - mSpent, "hard budget");
            assertEq(autoLeft, mSpent >= AUTO_PER_PERIOD ? 0 : AUTO_PER_PERIOD - mSpent, "auto budget");
        }
        assertEq(token.balanceOf(vendor), paidOut);
        assertEq(token.balanceOf(attacker), 0);
        assertEq(token.balanceOf(owner), FUNDING - paidOut);
    }

    function testFuzz_onlyAllowlistedRecipientsReceive(address to, uint256 amount) public {
        vm.assume(to != vendor && to != vendor2);
        amount = bound(amount, 1, MAX_PER_TX);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.RecipientNotAllowed.selector, to));
        pay(to, amount);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.RecipientNotAllowed.selector, to));
        module.reserve(owner, auth(to, amount, keccak256(abi.encode(to))), 0);
    }

    function testFuzz_onlyAgentsAct(address caller) public {
        vm.assume(caller != agent);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.NotAgent.selector, caller));
        module.pay(owner, address(token), vendor, 1, 0);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(AllowanceModule.NotAgent.selector, caller));
        module.reserve(owner, auth(vendor, 1, bytes32(0)), 0);
    }

    /// @dev A reservation authorizes exactly one (to, value, validAfter, validBefore, nonce). Any change fails.
    function testFuzz_reservationIsExact(
        uint256 value,
        bool changeTo,
        bool changeValue,
        bool changeAfter,
        bool changeBefore,
        bool changeNonce,
        uint256 delta
    ) public {
        value = bound(value, 1, COSIGN_ABOVE);
        delta = bound(delta, 1, 100);
        AllowanceModule.Authorization memory a = auth(vendor, value, keccak256(abi.encode(value)));
        (bool ok,,) = reserve(a);
        assertTrue(ok);

        AllowanceModule.Authorization memory b = a;
        if (changeTo) b.to = vendor2; // even another allowlisted recipient
        if (changeValue) b.value = a.value + delta;
        if (changeAfter) b.validAfter = a.validAfter - delta;
        if (changeBefore) b.validBefore = a.validBefore - delta;
        if (changeNonce) b.nonce = bytes32(uint256(a.nonce) ^ delta);
        bool tampered = changeTo || changeValue || changeAfter || changeBefore || changeNonce;

        if (tampered) vm.expectRevert(MockEIP3009Token.InvalidSignature.selector);
        settle(b);
        if (!tampered) assertEq(token.balanceOf(vendor), value);
    }

    function testFuzz_signaturesNeverValidateUnreservedHashes(bytes32 hash, bytes calldata tail) public view {
        assertEq(acct().isValidSignature(hash, abi.encodePacked(address(module), tail)), bytes4(0xffffffff));
    }

    function testFuzz_limitsValidation(AllowanceModule.TokenLimits memory l) public {
        bool valid = l.maxPerPeriod == 0
            || (
                l.period != 0 && l.maxPerTx != 0 && l.maxPerTx <= l.maxPerPeriod && l.autoPerPeriod <= l.maxPerPeriod
                    && l.cosignAbove <= l.maxPerTx
            );
        vm.prank(owner);
        if (!valid) vm.expectRevert(AllowanceModule.InvalidLimits.selector);
        module.setTokenLimits(address(token), l);
    }
}
