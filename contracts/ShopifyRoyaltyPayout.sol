// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract ShopifyRoyaltyPayout is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    IERC20  public immutable token; // e.g. USDC on L2/testnet
    mapping(bytes32 => bool) public processed; // batchId => used
    mapping(address => uint256) public balances;

    event BatchProcessed(bytes32 indexed batchId, uint256 total, uint256 count, bytes32 batchHash);
    event Withdraw(address indexed payee, uint256 amount, address to);

    struct Item { address payee; uint256 amount; }

    constructor(address token_, address admin, address oracle) {
        require(token_ != address(0), "token=0");
        token = IERC20(token_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, oracle);
    }

    function submitBatch(
        bytes32 batchId,
        uint256 total,
        Item[] calldata items,
        bytes32 batchHash  // optional: keccak256 of canonicalized items JSON
    ) external onlyRole(ORACLE_ROLE) {
        require(!processed[batchId], "batch used");
        require(items.length > 0, "empty");
        require(token.balanceOf(address(this)) >= total, "funds?");

        uint256 sum;
        for (uint i; i < items.length; i++) {
            require(items[i].payee != address(0), "payee=0");
            sum += items[i].amount;
        }
        require(sum == total, "sum != total");

        processed[batchId] = true;
        for (uint i; i < items.length; i++) {
            balances[items[i].payee] += items[i].amount;
        }
        emit BatchProcessed(batchId, total, items.length, batchHash);
    }

    function withdraw(address to, uint256 amt) external nonReentrant {
        require(to != address(0) && amt > 0, "param");
        uint256 b = balances[msg.sender];
        require(b >= amt, "insufficient");
        unchecked { balances[msg.sender] = b - amt; }
        token.safeTransfer(to, amt);
        emit Withdraw(msg.sender, amt, to);
    }

    function setOracle(address o) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _grantRole(ORACLE_ROLE, o);
    }
}
