// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MultiSend
 * @dev Contract for batch sending ETH and ERC20 tokens
 */
contract MultiSend is Ownable {
    event BatchEthSent(address indexed sender, uint256 totalAmount, uint256 recipientCount);
    event BatchTokenSent(address indexed sender, address indexed token, uint256 totalAmount, uint256 recipientCount);

    constructor() Ownable(msg.sender) {}

    /**
     * @dev Batch send ETH to multiple recipients
     * @param recipients Array of recipient addresses
     * @param amounts Array of amounts to send (in wei)
     */
    function batchSendETH(address[] calldata recipients, uint256[] calldata amounts) external payable {
        require(recipients.length == amounts.length, "MultiSend: Arrays length mismatch");
        require(recipients.length > 0, "MultiSend: Empty arrays");

        uint256 totalAmount = 0;

        // Calculate total amount needed
        for (uint256 i = 0; i < amounts.length; i++) {
            totalAmount += amounts[i];
        }

        require(msg.value >= totalAmount, "MultiSend: Insufficient ETH sent");

        // Send ETH to each recipient
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "MultiSend: Invalid recipient address");
            require(amounts[i] > 0, "MultiSend: Amount must be greater than 0");

            (bool success, ) = payable(recipients[i]).call{value: amounts[i]}("");
            require(success, "MultiSend: ETH transfer failed");
        }

        // Refund excess ETH
        if (msg.value > totalAmount) {
            (bool success, ) = payable(msg.sender).call{value: msg.value - totalAmount}("");
            require(success, "MultiSend: Refund failed");
        }

        emit BatchEthSent(msg.sender, totalAmount, recipients.length);
    }

    /**
     * @dev Batch send ERC20 tokens to multiple recipients
     * @param token ERC20 token contract address
     * @param recipients Array of recipient addresses
     * @param amounts Array of amounts to send (in token units)
     */
    function batchSendToken(address token, address[] calldata recipients, uint256[] calldata amounts) external {
        require(token != address(0), "MultiSend: Invalid token address");
        require(recipients.length == amounts.length, "MultiSend: Arrays length mismatch");
        require(recipients.length > 0, "MultiSend: Empty arrays");

        IERC20 tokenContract = IERC20(token);
        uint256 totalAmount = 0;

        // Calculate total amount needed
        for (uint256 i = 0; i < amounts.length; i++) {
            totalAmount += amounts[i];
        }

        // Check sender's balance and allowance
        require(tokenContract.balanceOf(msg.sender) >= totalAmount, "MultiSend: Insufficient token balance");
        require(tokenContract.allowance(msg.sender, address(this)) >= totalAmount, "MultiSend: Insufficient allowance");

        // Transfer tokens to each recipient
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "MultiSend: Invalid recipient address");
            require(amounts[i] > 0, "MultiSend: Amount must be greater than 0");

            bool success = tokenContract.transferFrom(msg.sender, recipients[i], amounts[i]);
            require(success, "MultiSend: Token transfer failed");
        }

        emit BatchTokenSent(msg.sender, token, totalAmount, recipients.length);
    }

    /**
     * @dev Batch send same amount of ETH to multiple recipients
     * @param recipients Array of recipient addresses
     * @param amountPerRecipient Amount to send to each recipient (in wei)
     */
    function batchSendETHSameAmount(address[] calldata recipients, uint256 amountPerRecipient) external payable {
        require(recipients.length > 0, "MultiSend: Empty recipients array");
        require(amountPerRecipient > 0, "MultiSend: Amount must be greater than 0");

        uint256 totalAmount = amountPerRecipient * recipients.length;
        require(msg.value >= totalAmount, "MultiSend: Insufficient ETH sent");

        // Send ETH to each recipient
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "MultiSend: Invalid recipient address");

            (bool success, ) = payable(recipients[i]).call{value: amountPerRecipient}("");
            require(success, "MultiSend: ETH transfer failed");
        }

        // Refund excess ETH
        if (msg.value > totalAmount) {
            (bool success, ) = payable(msg.sender).call{value: msg.value - totalAmount}("");
            require(success, "MultiSend: Refund failed");
        }

        emit BatchEthSent(msg.sender, totalAmount, recipients.length);
    }

    /**
     * @dev Batch send same amount of tokens to multiple recipients
     * @param token ERC20 token contract address
     * @param recipients Array of recipient addresses
     * @param amountPerRecipient Amount to send to each recipient (in token units)
     */
    function batchSendTokenSameAmount(
        address token,
        address[] calldata recipients,
        uint256 amountPerRecipient
    ) external {
        require(token != address(0), "MultiSend: Invalid token address");
        require(recipients.length > 0, "MultiSend: Empty recipients array");
        require(amountPerRecipient > 0, "MultiSend: Amount must be greater than 0");

        IERC20 tokenContract = IERC20(token);
        uint256 totalAmount = amountPerRecipient * recipients.length;

        // Check sender's balance and allowance
        require(tokenContract.balanceOf(msg.sender) >= totalAmount, "MultiSend: Insufficient token balance");
        require(tokenContract.allowance(msg.sender, address(this)) >= totalAmount, "MultiSend: Insufficient allowance");

        // Transfer tokens to each recipient
        for (uint256 i = 0; i < recipients.length; i++) {
            require(recipients[i] != address(0), "MultiSend: Invalid recipient address");

            bool success = tokenContract.transferFrom(msg.sender, recipients[i], amountPerRecipient);
            require(success, "MultiSend: Token transfer failed");
        }

        emit BatchTokenSent(msg.sender, token, totalAmount, recipients.length);
    }

    /**
     * @dev Emergency function to withdraw stuck ETH (only owner)
     */
    function emergencyWithdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "MultiSend: No ETH to withdraw");

        (bool success, ) = payable(owner()).call{value: balance}("");
        require(success, "MultiSend: Withdrawal failed");
    }

    /**
     * @dev Emergency function to withdraw stuck tokens (only owner)
     */
    function emergencyWithdrawToken(address token) external onlyOwner {
        require(token != address(0), "MultiSend: Invalid token address");

        IERC20 tokenContract = IERC20(token);
        uint256 balance = tokenContract.balanceOf(address(this));
        require(balance > 0, "MultiSend: No tokens to withdraw");

        bool success = tokenContract.transfer(owner(), balance);
        require(success, "MultiSend: Token withdrawal failed");
    }

    /**
     * @dev Get contract ETH balance
     */
    function getETHBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @dev Get contract token balance
     */
    function getTokenBalance(address token) external view returns (uint256) {
        require(token != address(0), "MultiSend: Invalid token address");
        return IERC20(token).balanceOf(address(this));
    }

    // Allow contract to receive ETH
    receive() external payable {}
    fallback() external payable {}
}
