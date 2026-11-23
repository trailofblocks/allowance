// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Base} from "./Base.t.sol";
import {AllowanceModule} from "../contracts/AllowanceModule.sol";
import {AgentAccount} from "../contracts/AgentAccount.sol";
import {MockEIP3009Token} from "../contracts/mocks/MockEIP3009Token.sol";

/**
 * @dev Drives the module the way the world would: an agent paying and reserving (sometimes to the
 * attacker, sometimes over its limits), a co-signer approving and rejecting, a facilitator settling,
 * an attacker forging authorizations and calling everything it can, time passing, and the owner
 * pausing. It keeps its own books (ghost variables) instead of trusting the module's.
 */
contract Handler is Test {
    AllowanceModule internal module;
    MockEIP3009Token internal token;
    address internal account;
    address internal agent;
    address internal cosigner;
    address internal attacker;
    address internal facilitator;
    address[3] internal recipients;

    uint256 internal immutable maxPerTx;
    uint256 internal immutable cosignAbove;
    uint256 internal immutable autoPerPeriod;
    uint256 internal immutable maxPerPeriod;
    uint256 internal immutable period;
    uint256 internal immutable anchor;

    struct Res {
        AllowanceModule.Authorization a;
        bytes32 digest;
        uint256 window;
        bool settled;
        bool released;
    }

    struct Req {
        uint256 id;
        bool isReservation;
        AllowanceModule.Authorization a;
        bool open;
    }

    Res[] internal reservations;
    Req[] internal requests;

    // Ghost books.
    mapping(uint256 window => uint256) public windowTotal;
    uint256[] public windowsTouched;
    mapping(uint256 window => bool) internal touched;
    uint256 public outflow;
    uint256 public autoViolations;
    uint256 public perTxViolations;
    uint256 public cosignViolations;
    uint256 public refundViolations;
    uint256 public lateSettlements;
    bool public paused;
    uint256 public calls;
    uint256 public approvals;
    uint256 public maxWindowTotal;

    constructor(
        AllowanceModule module_,
        MockEIP3009Token token_,
        address account_,
        address agent_,
        address cosigner_,
        address attacker_,
        address facilitator_,
        address[3] memory recipients_
    ) {
        module = module_;
        token = token_;
        account = account_;
        agent = agent_;
        cosigner = cosigner_;
        attacker = attacker_;
        facilitator = facilitator_;
        recipients = recipients_;
        AllowanceModule.TokenPolicy memory p = module.tokenPolicy(account, address(token));
        maxPerTx = p.maxPerTx;
        cosignAbove = p.cosignAbove;
        autoPerPeriod = p.autoPerPeriod;
        maxPerPeriod = p.maxPerPeriod;
        period = p.period;
        anchor = p.anchor;
    }

    // ------------------------------------------------------------------------------ actions

    function agentPay(uint256 amountSeed, uint256 toSeed) external {
        calls++;
        uint256 amount = bound(amountSeed, 0, 600e6);
        address to = recipients[toSeed % 3];
        uint256 w = _window();
        uint256 before = windowTotal[w];
        vm.prank(agent);
        try module.pay(account, address(token), to, amount, "inv") returns (bool paid, uint256 id) {
            if (paid) {
                _count(w, amount);
                _outflow(amount);
                if (before + amount > autoPerPeriod) autoViolations++;
                if (amount > cosignAbove) cosignViolations++;
            } else {
                AllowanceModule.Authorization memory none;
                none.to = to;
                none.value = amount;
                requests.push(Req(id, false, none, true));
            }
        } catch {}
    }

    function agentReserve(uint256 amountSeed, uint256 toSeed, uint256 ttlSeed) external {
        calls++;
        uint256 amount = bound(amountSeed, 0, 600e6);
        AllowanceModule.Authorization memory a = AllowanceModule.Authorization({
            token: address(token),
            to: recipients[toSeed % 3],
            value: amount,
            validAfter: block.timestamp - 600,
            validBefore: block.timestamp + bound(ttlSeed, 1, 2 hours),
            nonce: keccak256(abi.encode(calls, amountSeed, toSeed, ttlSeed))
        });
        uint256 w = _window();
        uint256 before = windowTotal[w];
        vm.prank(agent);
        try module.reserve(account, a, "inv") returns (bool ok, bytes32 digest, uint256 id) {
            if (ok) {
                _count(w, amount);
                reservations.push(Res(a, digest, w, false, false));
                if (before + amount > autoPerPeriod) autoViolations++;
                if (amount > cosignAbove) cosignViolations++;
            } else {
                requests.push(Req(id, true, a, true));
            }
        } catch {}
    }

    /// @dev Half the time the newest open request (the co-signer answering promptly), half a random one.
    function cosignerApproves(uint256 seed) external {
        calls++;
        if (requests.length == 0) return;
        uint256 i = seed % requests.length;
        if (seed % 2 == 0) {
            i = requests.length;
            while (i > 0 && !requests[i - 1].open) i--;
            if (i == 0) return;
            i--;
        }
        Req storage r = requests[i];
        if (!r.open) return;
        uint256 w = _window();
        vm.prank(cosigner);
        try module.approve(account, r.id) {
            r.open = false;
            approvals++;
            _count(w, r.a.value);
            if (r.isReservation) {
                bytes32 digest = module.authorizationDigest(
                    account, address(token), r.a.to, r.a.value, r.a.validAfter, r.a.validBefore, r.a.nonce
                );
                reservations.push(Res(r.a, digest, w, false, false));
            } else {
                _outflow(r.a.value);
            }
        } catch {}
    }

    function cosignerRejects(uint256 seed) external {
        calls++;
        if (requests.length == 0) return;
        Req storage r = requests[seed % requests.length];
        vm.prank(cosigner);
        try module.reject(account, r.id) {
            r.open = false;
        } catch {}
    }

    function facilitatorSettles(uint256 seed) external {
        calls++;
        if (reservations.length == 0) return;
        Res storage r = reservations[seed % reservations.length];
        vm.prank(facilitator);
        try token.transferWithAuthorization(
            account,
            r.a.to,
            r.a.value,
            r.a.validAfter,
            r.a.validBefore,
            r.a.nonce,
            abi.encodePacked(address(module))
        ) {
            if (r.settled || r.released || block.timestamp >= r.a.validBefore || paused) lateSettlements++;
            r.settled = true;
            _outflow(r.a.value);
        } catch {}
    }

    function anyoneReleases(uint256 seed) external {
        calls++;
        if (reservations.length == 0) return;
        Res storage r = reservations[seed % reservations.length];
        uint256 w = _window();
        try module.release(account, r.digest) returns (uint256 refunded) {
            r.released = true;
            if (refunded > 0) {
                if (r.settled || refunded > r.a.value || w != r.window) refundViolations++;
                windowTotal[r.window] -= refunded;
            }
        } catch {}
    }

    /// @dev The attacker tries every door: forged authorizations, reserved ones with its own address,
    /// the agent-only and co-signer-only entry points, and the account itself.
    function attackerTries(uint256 amountSeed, uint256 seed) external {
        calls++;
        uint256 amount = bound(amountSeed, 1, 600e6);
        bytes memory moduleSig = abi.encodePacked(address(module));
        vm.startPrank(attacker);
        try token.transferWithAuthorization(
            account, attacker, amount, 0, block.timestamp + 60, bytes32(seed), moduleSig
        ) {} catch {}
        if (reservations.length > 0) {
            Res storage r = reservations[seed % reservations.length];
            try token.transferWithAuthorization(
                account, attacker, r.a.value, r.a.validAfter, r.a.validBefore, r.a.nonce, moduleSig
            ) {} catch {}
        }
        try module.pay(account, address(token), attacker, amount, "") {} catch {}
        if (requests.length > 0) {
            try module.approve(account, requests[seed % requests.length].id) {} catch {}
        }
        module.setRecipient(attacker, true); // edits the attacker's own (empty) policy only
        try AgentAccount(payable(account)).execute(
            bytes32(0),
            abi.encodePacked(address(token), uint256(0), abi.encodeCall(token.transfer, (attacker, amount)))
        ) {} catch {}
        try AgentAccount(payable(account)).executeFromExecutor(
            bytes32(0),
            abi.encodePacked(address(token), uint256(0), abi.encodeCall(token.transfer, (attacker, amount)))
        ) {} catch {}
        vm.stopPrank();
    }

    /// @dev Mostly small steps, so windows fill up; sometimes a jump of up to two periods.
    function timePasses(uint256 secondsSeed) external {
        calls++;
        uint256 step = secondsSeed % 8 == 0 ? bound(secondsSeed, 0, 2 days) : bound(secondsSeed, 0, 2 hours);
        vm.warp(block.timestamp + step);
    }

    /// @dev Rare, so most of the campaign runs unpaused.
    function cosignerPauses(uint256 seed) external {
        calls++;
        if (seed % 6 != 0) return;
        vm.prank(cosigner);
        module.pause(account);
        paused = true;
    }

    function ownerUnpauses() external {
        calls++;
        vm.prank(account);
        AgentAccount(payable(account)).execute(
            bytes32(0), abi.encodePacked(address(module), uint256(0), abi.encodeCall(AllowanceModule.unpause, ()))
        );
        paused = false;
    }

    // ------------------------------------------------------------------------------ views for invariants

    function reservationCount() external view returns (uint256) {
        return reservations.length;
    }

    function reservationAt(uint256 i) external view returns (bytes32 digest, uint256 validBefore, bool released) {
        Res storage r = reservations[i];
        return (r.digest, r.a.validBefore, r.released);
    }

    function windowsTouchedCount() external view returns (uint256) {
        return windowsTouched.length;
    }

    // ------------------------------------------------------------------------------ internals

    function _window() internal view returns (uint256) {
        return (block.timestamp - anchor) / period;
    }

    function _count(uint256 w, uint256 amount) internal {
        windowTotal[w] += amount;
        if (windowTotal[w] > maxWindowTotal) maxWindowTotal = windowTotal[w];
        if (!touched[w]) {
            touched[w] = true;
            windowsTouched.push(w);
        }
    }

    function _outflow(uint256 amount) internal {
        outflow += amount;
        if (amount > maxPerTx) perTxViolations++;
    }
}

contract AllowanceInvariantTest is Base {
    Handler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new Handler(module, token, owner, agent, cosigner, attacker, facilitator, [vendor, vendor2, attacker]);
        targetContract(address(handler));
    }

    /// The attacker, who is not on the allowlist, never receives a single unit.
    function invariant_attackerGetsNothing() public view {
        assertEq(token.balanceOf(attacker), 0);
    }

    /// Every window's total (payments plus reservations, minus refunds) stays within the hard cap.
    function invariant_windowTotalsWithinHardCap() public view {
        uint256 n = handler.windowsTouchedCount();
        for (uint256 i; i < n; ++i) {
            assertLe(handler.windowTotal(handler.windowsTouched(i)), MAX_PER_PERIOD);
        }
    }

    /// Nothing the agent did alone pushed a window past autoPerPeriod or a payment past cosignAbove.
    function invariant_noUncosignedSpendBeyondAutoBudget() public view {
        assertEq(handler.autoViolations(), 0, "window total above autoPerPeriod without a co-signature");
        assertEq(handler.cosignViolations(), 0, "payment above cosignAbove without a co-signature");
    }

    function invariant_noPaymentAbovePerTxCap() public view {
        assertEq(handler.perTxViolations(), 0);
    }

    /// Refunds only return unused reservations, into the window they were counted in.
    function invariant_refundsAreHonest() public view {
        assertEq(handler.refundViolations(), 0);
    }

    /// No authorization settled after it expired, was released, or while the module was paused.
    function invariant_noLateSettlement() public view {
        assertEq(handler.lateSettlements(), 0);
    }

    /// Conservation: everything that left the account is a payment or settlement the books recorded.
    function invariant_conservation() public view {
        assertEq(FUNDING - token.balanceOf(owner), handler.outflow());
        assertEq(token.balanceOf(vendor) + token.balanceOf(vendor2), handler.outflow());
    }

    /// The module's own counter agrees with the independent books.
    function invariant_moduleCounterMatchesBooks() public view {
        AllowanceModule.TokenPolicy memory p = module.tokenPolicy(owner, address(token));
        assertEq(p.spent, handler.windowTotal(p.windowIndex));
    }

    /// The account signs a reserved digest only while the reservation is live and the module unpaused.
    function invariant_signaturesOnlyForLiveReservations() public view {
        uint256 n = handler.reservationCount();
        for (uint256 i; i < n; ++i) {
            (bytes32 digest, uint256 validBefore, bool released) = handler.reservationAt(i);
            bool live = !released && block.timestamp < validBefore && !handler.paused();
            bytes4 got = acct().isValidSignature(digest, abi.encodePacked(address(module)));
            assertEq(got == bytes4(0x1626ba7e), live);
        }
    }

    function afterInvariant() public view {
        // Make sure runs actually exercised the handler (guards against a silently broken target).
        assertGt(handler.calls(), 0);
    }
}
