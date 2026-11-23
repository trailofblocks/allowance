// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    IERC7579Module,
    IERC7579Validator,
    IERC7579Execution,
    MODULE_TYPE_VALIDATOR,
    MODULE_TYPE_EXECUTOR,
    VALIDATION_FAILED
} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/// @dev The parts of an EIP-3009 token (such as USDC) the module reads.
interface IEIP3009 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}

/**
 * @title AllowanceModule
 * @notice Spending policy for an AI agent's payments from an ERC-7579 smart account.
 *
 * Money can leave an account in two ways, and the module covers both:
 *
 * - **A transaction.** Installed as an *executor*, the module lets an agent key call {pay}. The module
 *   checks the policy and then makes the account run exactly `token.transfer(to, amount)`. The agent
 *   never supplies calldata, so it can't approve a spender, call another contract, or change the policy.
 * - **A signature.** x402's `exact` scheme pays with an EIP-3009 `transferWithAuthorization` that the
 *   payer signs and a facilitator submits. Installed as a *validator*, the module answers the account's
 *   ERC-1271 `isValidSignature` with "valid" only for authorizations it reserved through {reserve}, which
 *   runs the same policy checks and counts the amount when it is reserved.
 *
 * Policy, per account and per token:
 * - only allowlisted recipients, only configured tokens, only registered agent keys;
 * - `maxPerTx` per payment and `maxPerPeriod` per fixed window, hard caps that a co-signature can't lift;
 * - a payment above `cosignAbove`, or one that would take the window's total above `autoPerPeriod`,
 *   waits for the account's co-signer (or the account itself) to approve it.
 *
 * Windows are fixed: window `i` covers `[anchor + i*period, anchor + (i+1)*period)`. Any span of one
 * period can therefore straddle two windows and see up to `2 * maxPerPeriod`.
 *
 * All state is keyed by account. Uninstalling the module wipes the account's state.
 */
contract AllowanceModule is IERC7579Validator, ReentrancyGuardTransient {
    // ------------------------------------------------------------------------------------------ types

    struct TokenLimits {
        uint128 maxPerTx;
        uint128 cosignAbove;
        uint128 autoPerPeriod;
        uint128 maxPerPeriod;
        uint64 period;
    }

    struct TokenPolicy {
        uint128 maxPerTx;
        uint128 cosignAbove;
        uint128 autoPerPeriod;
        uint128 maxPerPeriod;
        uint64 period;
        uint64 anchor;
        uint64 windowIndex;
        uint128 spent;
    }

    enum Kind {
        None,
        Transfer,
        Reservation
    }

    struct Pending {
        Kind kind;
        uint64 expiresAt;
        address agent;
        address token;
        address to;
        uint128 amount;
        uint64 validAfter;
        uint64 validBefore;
        bytes32 nonce;
        bytes32 ref;
    }

    struct Reservation {
        address token;
        uint128 amount;
        uint64 validBefore;
        uint64 anchor;
        uint64 windowIndex;
        bytes32 nonce;
        address to;
        address agent;
    }

    /// @dev The fields of an EIP-3009 `transferWithAuthorization`, minus `from` (the account).
    struct Authorization {
        address token;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
    }

    struct TokenInit {
        address token;
        TokenLimits limits;
    }

    /// @dev `onInstall` data for the executor install. The validator install takes empty data.
    struct InitConfig {
        address[] agents;
        address cosigner;
        address[] recipients;
        TokenInit[] tokens;
        uint32 pendingTtl;
        uint32 maxAuthWindow;
    }

    struct AccountState {
        address cosigner;
        bool paused;
        uint32 pendingTtl;
        uint32 maxAuthWindow;
        uint64 nextPendingId;
        mapping(address agent => bool) agents;
        mapping(address recipient => bool) recipients;
        mapping(address token => TokenPolicy) tokens;
        mapping(uint256 id => Pending) pending;
        mapping(bytes32 digest => Reservation) reservations;
    }

    // ------------------------------------------------------------------------------------------ constants

    /// @dev keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    uint32 public constant DEFAULT_PENDING_TTL = 1 days;
    uint32 public constant DEFAULT_MAX_AUTH_WINDOW = 1 hours;

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 private constant ERC1271_INVALID = 0xffffffff;

    // ------------------------------------------------------------------------------------------ storage

    mapping(address account => uint256) private _epoch;
    mapping(address account => mapping(uint256 epoch => AccountState)) private _state;

    // ------------------------------------------------------------------------------------------ events

    event Paid(
        address indexed account,
        address indexed token,
        address indexed to,
        uint256 amount,
        address agent,
        bytes32 ref,
        bool cosigned
    );
    event Reserved(
        address indexed account,
        address indexed token,
        address indexed to,
        uint256 amount,
        bytes32 digest,
        address agent,
        bytes32 ref,
        bool cosigned
    );
    event Released(address indexed account, bytes32 indexed digest, uint256 refunded);
    event Queued(address indexed account, uint256 indexed id, Kind kind, address token, address to, uint256 amount, address agent, bytes32 ref);
    event Approved(address indexed account, uint256 indexed id, address by);
    event Rejected(address indexed account, uint256 indexed id, address by);
    event AgentSet(address indexed account, address indexed agent, bool enabled);
    event RecipientSet(address indexed account, address indexed recipient, bool allowed);
    event CosignerSet(address indexed account, address cosigner);
    event TokenLimitsSet(address indexed account, address indexed token, TokenLimits limits);
    event TimeoutsSet(address indexed account, uint32 pendingTtl, uint32 maxAuthWindow);
    event PausedSet(address indexed account, bool paused, address by);

    // ------------------------------------------------------------------------------------------ errors

    error NotAgent(address caller);
    error NotAccount(address caller);
    error NotApprover(address caller);
    error IsPaused();
    error RecipientNotAllowed(address recipient);
    error TokenNotConfigured(address token);
    error ZeroAmount();
    error OverPerTxLimit(uint256 amount, uint256 maxPerTx);
    error OverPeriodLimit(uint256 amount, uint256 remaining);
    error BadValidity(uint256 validAfter, uint256 validBefore);
    error ReservationExists(bytes32 digest);
    error NonceUsed(bytes32 nonce);
    error UnknownPending(uint256 id);
    error PendingExpired(uint256 id);
    error UnknownReservation(bytes32 digest);
    error ReservationLive(bytes32 digest);
    error TransferFailed();
    error InvalidLimits();

    // ------------------------------------------------------------------------------------------ ERC-7579

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_EXECUTOR || moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    /// @notice Called by the account on install. Non-empty `data` is an ABI-encoded {InitConfig}.
    function onInstall(bytes calldata data) external {
        if (data.length == 0) return;
        InitConfig memory cfg = abi.decode(data, (InitConfig));
        address account = msg.sender;
        AccountState storage s = _s(account);
        for (uint256 i; i < cfg.agents.length; ++i) _setAgent(account, s, cfg.agents[i], true);
        for (uint256 i; i < cfg.recipients.length; ++i) _setRecipient(account, s, cfg.recipients[i], true);
        for (uint256 i; i < cfg.tokens.length; ++i) _setTokenLimits(account, s, cfg.tokens[i].token, cfg.tokens[i].limits);
        s.cosigner = cfg.cosigner;
        emit CosignerSet(account, cfg.cosigner);
        _setTimeouts(account, s, cfg.pendingTtl, cfg.maxAuthWindow);
    }

    /// @notice Called by the account on uninstall. Forgets everything about the account.
    function onUninstall(bytes calldata) external {
        unchecked {
            ++_epoch[msg.sender];
        }
    }

    /// @notice True once the account has set timeouts, which happens on an install with config.
    function isInitialized(address account) external view returns (bool) {
        return _state[account][_epoch[account]].pendingTtl != 0;
    }

    /// @notice The module never validates user operations. Agents act through {pay} and {reserve}.
    function validateUserOp(PackedUserOperation calldata, bytes32) external pure returns (uint256) {
        return VALIDATION_FAILED;
    }

    /**
     * @notice ERC-1271 via the account: valid only for a live, reserved EIP-3009 authorization digest whose
     * agent key, recipient, and token are all still allowed, while the module is not paused.
     * @dev `msg.sender` is the account. The signature bytes after the validator prefix are ignored: the
     * reservation itself is the authorization. `sender` is not checked, because facilitators verify with
     * an `eth_call` that may come from any address; the digest already commits to the token contract,
     * the chain, the payer, the recipient, the amount, the validity window, and the nonce.
     */
    function isValidSignatureWithSender(address, bytes32 hash, bytes calldata) external view returns (bytes4) {
        AccountState storage s = _s(msg.sender);
        Reservation storage r = s.reservations[hash];
        if (r.amount == 0 || s.paused || block.timestamp >= r.validBefore) return ERC1271_INVALID;
        // Revoking the agent key, the recipient, or the token's limits also revokes outstanding authorizations.
        if (!s.agents[r.agent] || !s.recipients[r.to] || s.tokens[r.token].period == 0) return ERC1271_INVALID;
        return ERC1271_MAGIC;
    }

    // ------------------------------------------------------------------------------------------ agent actions

    /**
     * @notice Pay `amount` of `token` to `to` from `account`. Called by a registered agent key.
     * @return paid True if the transfer ran now; false if it is waiting for a co-signature.
     * @return pendingId The id of the queued request when `paid` is false.
     */
    function pay(address account, address token, address to, uint256 amount, bytes32 ref)
        external
        nonReentrant
        returns (bool paid, uint256 pendingId)
    {
        AccountState storage s = _s(account);
        if (!s.agents[msg.sender]) revert NotAgent(msg.sender);
        (TokenPolicy storage p, uint128 amt) = _checkCommon(s, token, to, amount);

        if (_needsCosign(p, amt)) {
            pendingId = _queue(account, s, Pending(Kind.Transfer, 0, msg.sender, token, to, amt, 0, 0, 0, ref));
            return (false, pendingId);
        }
        p.spent += amt;
        emit Paid(account, token, to, amt, msg.sender, ref, false);
        _transfer(account, token, to, amt);
        return (true, 0);
    }

    /**
     * @notice Reserve an EIP-3009 `transferWithAuthorization` from `account` so the account will sign it.
     * The amount counts against the window now. Called by a registered agent key.
     * @return reserved True if the authorization is valid now; false if it is waiting for a co-signature.
     * @return digest The EIP-712 digest the token will ask the account to validate.
     * @return pendingId The id of the queued request when `reserved` is false.
     */
    function reserve(address account, Authorization calldata a, bytes32 ref)
        external
        nonReentrant
        returns (bool reserved, bytes32 digest, uint256 pendingId)
    {
        AccountState storage s = _s(account);
        if (!s.agents[msg.sender]) revert NotAgent(msg.sender);
        (TokenPolicy storage p, uint128 amt) = _checkCommon(s, a.token, a.to, a.value);
        _checkValidity(s, a.validAfter, a.validBefore);
        digest = authorizationDigest(account, a.token, a.to, a.value, a.validAfter, a.validBefore, a.nonce);
        _checkFresh(account, s, a.token, digest, a.nonce);

        if (_needsCosign(p, amt)) {
            Pending memory q = Pending({
                kind: Kind.Reservation,
                expiresAt: 0,
                agent: msg.sender,
                token: a.token,
                to: a.to,
                amount: amt,
                validAfter: uint64(a.validAfter),
                validBefore: uint64(a.validBefore),
                nonce: a.nonce,
                ref: ref
            });
            return (false, digest, _queue(account, s, q));
        }
        p.spent += amt;
        s.reservations[digest] =
            Reservation(a.token, amt, uint64(a.validBefore), p.anchor, p.windowIndex, a.nonce, a.to, msg.sender);
        emit Reserved(account, a.token, a.to, amt, digest, msg.sender, ref, false);
        return (true, digest, 0);
    }

    /**
     * @notice Clear a reservation once it can no longer be used. Anyone may call this.
     * If the authorization was never used and its window is still current, the amount is credited back.
     */
    function release(address account, bytes32 digest) external nonReentrant returns (uint256 refunded) {
        AccountState storage s = _s(account);
        Reservation memory r = s.reservations[digest];
        if (r.amount == 0) revert UnknownReservation(digest);
        bool used = IEIP3009(r.token).authorizationState(account, r.nonce);
        if (!used && block.timestamp < r.validBefore) revert ReservationLive(digest);
        delete s.reservations[digest];
        if (!used) {
            TokenPolicy storage p = s.tokens[r.token];
            if (p.period != 0) {
                _roll(p);
                // Credit back only into the same window of the same configuration it was counted in.
                if (p.anchor == r.anchor && p.windowIndex == r.windowIndex) {
                    refunded = r.amount <= p.spent ? r.amount : p.spent;
                    p.spent -= uint128(refunded);
                }
            }
        }
        emit Released(account, digest, refunded);
    }

    // ------------------------------------------------------------------------------------------ co-signer actions

    /// @notice Approve a queued request. Called by the account's co-signer or the account itself.
    function approve(address account, uint256 id) external nonReentrant {
        AccountState storage s = _s(account);
        if (msg.sender != s.cosigner && msg.sender != account) revert NotApprover(msg.sender);
        Pending memory q = s.pending[id];
        if (q.kind == Kind.None) revert UnknownPending(id);
        if (block.timestamp >= q.expiresAt) revert PendingExpired(id);
        // An agent key removed since it asked can't have its requests approved.
        if (!s.agents[q.agent]) revert NotAgent(q.agent);
        delete s.pending[id];

        (TokenPolicy storage p, uint128 amt) = _checkCommon(s, q.token, q.to, q.amount);
        p.spent += amt;
        emit Approved(account, id, msg.sender);
        if (q.kind == Kind.Transfer) {
            emit Paid(account, q.token, q.to, amt, q.agent, q.ref, true);
            _transfer(account, q.token, q.to, amt);
        } else {
            _checkValidity(s, q.validAfter, q.validBefore);
            bytes32 digest = authorizationDigest(account, q.token, q.to, amt, q.validAfter, q.validBefore, q.nonce);
            _checkFresh(account, s, q.token, digest, q.nonce);
            s.reservations[digest] =
                Reservation(q.token, amt, q.validBefore, p.anchor, p.windowIndex, q.nonce, q.to, q.agent);
            emit Reserved(account, q.token, q.to, amt, digest, q.agent, q.ref, true);
        }
    }

    /// @notice Drop a queued request. Called by the account's co-signer or the account itself.
    function reject(address account, uint256 id) external {
        AccountState storage s = _s(account);
        if (msg.sender != s.cosigner && msg.sender != account) revert NotApprover(msg.sender);
        if (s.pending[id].kind == Kind.None) revert UnknownPending(id);
        delete s.pending[id];
        emit Rejected(account, id, msg.sender);
    }

    /// @notice Stop all agent payments and outstanding reservations. The co-signer or the account may pause.
    function pause(address account) external {
        AccountState storage s = _s(account);
        if (msg.sender != s.cosigner && msg.sender != account) revert NotApprover(msg.sender);
        s.paused = true;
        emit PausedSet(account, true, msg.sender);
    }

    // ------------------------------------------------------------------------------------------ owner (account) actions

    function unpause() external {
        _s(msg.sender).paused = false;
        emit PausedSet(msg.sender, false, msg.sender);
    }

    function setAgent(address agent, bool enabled) external {
        _setAgent(msg.sender, _s(msg.sender), agent, enabled);
    }

    function setRecipient(address recipient, bool allowed) external {
        _setRecipient(msg.sender, _s(msg.sender), recipient, allowed);
    }

    function setCosigner(address cosigner) external {
        _s(msg.sender).cosigner = cosigner;
        emit CosignerSet(msg.sender, cosigner);
    }

    /// @notice Configure a token. `maxPerPeriod == 0` removes it. Changing `period` starts a new window.
    function setTokenLimits(address token, TokenLimits calldata limits) external {
        _setTokenLimits(msg.sender, _s(msg.sender), token, limits);
    }

    function setTimeouts(uint32 pendingTtl, uint32 maxAuthWindow) external {
        _setTimeouts(msg.sender, _s(msg.sender), pendingTtl, maxAuthWindow);
    }

    // ------------------------------------------------------------------------------------------ views

    function authorizationDigest(
        address account,
        address token,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, account, to, value, validAfter, validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", IEIP3009(token).DOMAIN_SEPARATOR(), structHash));
    }

    /**
     * @notice What an agent can still spend from `account` in `token` right now.
     * @return autoLeft Spendable in this window without a co-signature (still subject to `cosignAbove`).
     * @return hardLeft Spendable in this window with a co-signature.
     * @return windowEnds When the current window ends (unix seconds).
     */
    function remaining(address account, address token)
        external
        view
        returns (uint256 autoLeft, uint256 hardLeft, uint64 windowEnds)
    {
        TokenPolicy memory p = _s(account).tokens[token];
        if (p.period == 0) return (0, 0, 0);
        uint64 idx = _windowIndex(p);
        uint128 spent = idx == p.windowIndex ? p.spent : 0;
        autoLeft = p.autoPerPeriod > spent ? p.autoPerPeriod - spent : 0;
        hardLeft = p.maxPerPeriod > spent ? p.maxPerPeriod - spent : 0;
        windowEnds = p.anchor + (idx + 1) * p.period;
    }

    function tokenPolicy(address account, address token) external view returns (TokenPolicy memory) {
        return _s(account).tokens[token];
    }

    function settings(address account)
        external
        view
        returns (address cosigner, bool paused, uint32 pendingTtl, uint32 maxAuthWindow, uint64 nextPendingId)
    {
        AccountState storage s = _s(account);
        return (s.cosigner, s.paused, s.pendingTtl, s.maxAuthWindow, s.nextPendingId);
    }

    function isAgent(address account, address agent) external view returns (bool) {
        return _s(account).agents[agent];
    }

    function isRecipient(address account, address recipient) external view returns (bool) {
        return _s(account).recipients[recipient];
    }

    function pendingRequest(address account, uint256 id) external view returns (Pending memory) {
        return _s(account).pending[id];
    }

    function reservation(address account, bytes32 digest) external view returns (Reservation memory) {
        return _s(account).reservations[digest];
    }

    // ------------------------------------------------------------------------------------------ internals

    function _s(address account) private view returns (AccountState storage) {
        return _state[account][_epoch[account]];
    }

    /// @dev Checks shared by every way of moving money, and rolls the token's window forward.
    function _checkCommon(AccountState storage s, address token, address to, uint256 amount)
        private
        returns (TokenPolicy storage p, uint128 amt)
    {
        if (s.paused) revert IsPaused();
        if (!s.recipients[to]) revert RecipientNotAllowed(to);
        p = s.tokens[token];
        if (p.period == 0) revert TokenNotConfigured(token);
        if (amount == 0) revert ZeroAmount();
        if (amount > p.maxPerTx) revert OverPerTxLimit(amount, p.maxPerTx);
        amt = uint128(amount); // maxPerTx is a uint128, so this can't truncate
        _roll(p);
        uint128 left = p.maxPerPeriod > p.spent ? p.maxPerPeriod - p.spent : 0;
        if (amt > left) revert OverPeriodLimit(amount, left);
    }

    function _needsCosign(TokenPolicy storage p, uint128 amt) private view returns (bool) {
        return amt > p.cosignAbove || p.spent + amt > p.autoPerPeriod;
    }

    /// @dev Also guarantees both values fit in a uint64 (validAfter < validBefore <= now + window).
    function _checkValidity(AccountState storage s, uint256 validAfter, uint256 validBefore) private view {
        if (
            validBefore <= block.timestamp || validAfter >= validBefore
                || validBefore > block.timestamp + _maxAuthWindow(s)
        ) revert BadValidity(validAfter, validBefore);
    }

    function _checkFresh(address account, AccountState storage s, address token, bytes32 digest, bytes32 nonce)
        private
        view
    {
        if (s.reservations[digest].amount != 0) revert ReservationExists(digest);
        if (IEIP3009(token).authorizationState(account, nonce)) revert NonceUsed(nonce);
    }

    function _queue(address account, AccountState storage s, Pending memory q) private returns (uint256 id) {
        id = ++s.nextPendingId;
        q.expiresAt = uint64(block.timestamp + _pendingTtl(s));
        s.pending[id] = q;
        emit Queued(account, id, q.kind, q.token, q.to, q.amount, q.agent, q.ref);
    }

    function _pendingTtl(AccountState storage s) private view returns (uint256) {
        return s.pendingTtl == 0 ? DEFAULT_PENDING_TTL : s.pendingTtl;
    }

    function _maxAuthWindow(AccountState storage s) private view returns (uint256) {
        return s.maxAuthWindow == 0 ? DEFAULT_MAX_AUTH_WINDOW : s.maxAuthWindow;
    }

    function _windowIndex(TokenPolicy memory p) private view returns (uint64) {
        return uint64((block.timestamp - p.anchor) / p.period);
    }

    function _roll(TokenPolicy storage p) private {
        uint64 idx = uint64((block.timestamp - p.anchor) / p.period);
        if (idx != p.windowIndex) {
            p.windowIndex = idx;
            p.spent = 0;
        }
    }

    function _transfer(address account, address token, address to, uint128 amount) private {
        if (token.code.length == 0) revert TransferFailed();
        bytes memory execution = abi.encodePacked(token, uint256(0), abi.encodeCall(IERC20.transfer, (to, amount)));
        // Mode 0: single call, revert on failure.
        bytes[] memory ret = IERC7579Execution(account).executeFromExecutor(bytes32(0), execution);
        if (ret.length != 1) revert TransferFailed();
        bytes memory r = ret[0];
        if (r.length != 0 && (r.length < 32 || !abi.decode(r, (bool)))) revert TransferFailed();
    }

    function _setAgent(address account, AccountState storage s, address agent, bool enabled) private {
        s.agents[agent] = enabled;
        emit AgentSet(account, agent, enabled);
    }

    function _setRecipient(address account, AccountState storage s, address recipient, bool allowed) private {
        s.recipients[recipient] = allowed;
        emit RecipientSet(account, recipient, allowed);
    }

    function _setTokenLimits(address account, AccountState storage s, address token, TokenLimits memory l) private {
        TokenPolicy storage p = s.tokens[token];
        if (l.maxPerPeriod == 0) {
            delete s.tokens[token];
            emit TokenLimitsSet(account, token, l);
            return;
        }
        if (
            l.period == 0 || l.maxPerTx == 0 || l.maxPerTx > l.maxPerPeriod || l.autoPerPeriod > l.maxPerPeriod
                || l.cosignAbove > l.maxPerTx || token.code.length == 0
        ) revert InvalidLimits();
        if (p.period != l.period) {
            p.period = l.period;
            p.anchor = uint64(block.timestamp);
            p.windowIndex = 0;
            p.spent = 0;
        }
        p.maxPerTx = l.maxPerTx;
        p.cosignAbove = l.cosignAbove;
        p.autoPerPeriod = l.autoPerPeriod;
        p.maxPerPeriod = l.maxPerPeriod;
        emit TokenLimitsSet(account, token, l);
    }

    function _setTimeouts(address account, AccountState storage s, uint32 pendingTtl, uint32 maxAuthWindow) private {
        s.pendingTtl = pendingTtl == 0 ? DEFAULT_PENDING_TTL : pendingTtl;
        s.maxAuthWindow = maxAuthWindow == 0 ? DEFAULT_MAX_AUTH_WINDOW : maxAuthWindow;
        emit TimeoutsSet(account, s.pendingTtl, s.maxAuthWindow);
    }
}
