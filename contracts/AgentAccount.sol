// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccountERC7579} from "@openzeppelin/contracts/account/extensions/draft-AccountERC7579.sol";
import {AbstractSigner} from "@openzeppelin/contracts/utils/cryptography/signers/AbstractSigner.sol";
import {SignerEIP7702} from "@openzeppelin/contracts/utils/cryptography/signers/SignerEIP7702.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/**
 * @title AgentAccount
 * @notice An ERC-7579 account for an ordinary EOA, upgraded in place with EIP-7702.
 *
 * The EOA's own key stays the owner: it configures modules by sending transactions to its own address
 * (`execute` and `installModule` accept calls from the account itself), and its signatures stay valid
 * for ERC-4337 and ERC-1271. The agent gets a different key, which only the AllowanceModule listens to.
 *
 * This is OpenZeppelin's AccountERC7579 with one change: when no installed validator accepts an
 * ERC-1271 signature, the EOA's own ECDSA signature is checked, so the owner can still sign messages.
 */
contract AgentAccount is AccountERC7579, SignerEIP7702 {
    function isValidSignature(bytes32 hash, bytes calldata signature)
        public
        view
        virtual
        override
        returns (bytes4)
    {
        bytes4 magic = super.isValidSignature(hash, signature);
        if (magic == IERC1271.isValidSignature.selector) return magic;
        return _rawSignatureValidation(hash, signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    function _rawSignatureValidation(bytes32 hash, bytes calldata signature)
        internal
        view
        virtual
        override(AccountERC7579, SignerEIP7702)
        returns (bool)
    {
        return SignerEIP7702._rawSignatureValidation(hash, signature);
    }
}
