// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FlashExecutor
/// @notice One shared contract for every user. It takes an optional flash loan, runs a list of steps, and sends what is left
/// to a recipient. It holds no funds between runs.
///
/// A step runs from this contract, or it makes a wallet act through a permission: a MetaMask Delegation Framework delegation
/// whose delegate is this contract. Such a permission must contain an ArgsEqualityCheckEnforcer caveat whose terms are
/// abi.encode(starter): this contract writes the address that started the run into the args of that caveat, so only that
/// address can use the permission. A permission without that caveat is refused.
///
/// Anyone can start a run. Never approve tokens to this contract and never leave funds in it.
contract FlashExecutor {
    struct Caveat {
        address enforcer;
        bytes terms;
        bytes args;
    }

    struct Delegation {
        address delegate;
        address delegator;
        bytes32 authority;
        Caveat[] caveats;
        uint256 salt;
        bytes signature;
    }

    /// @dev `wallet == address(0)`: the call runs from this contract.
    /// Else `permission` is abi.encode(Delegation[]) with one delegation from `wallet` to this contract, and the wallet makes the call.
    struct Step {
        address wallet;
        address target;
        uint256 value;
        bytes data;
        bytes permission;
    }

    enum Lender {
        None,
        Morpho,
        AaveV3
    }

    /// @notice Canonical Permit2. A step from this contract cannot call it.
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    bytes4 private constant TRANSFER_FROM = 0x23b872dd;

    address public immutable delegationManager;
    address public immutable argsEnforcer;

    /// @dev Set only during a run.
    address private _starter;
    address private _lender;
    address private _token;

    error Busy();
    error NotLender();
    error ForbiddenCall(uint256 index);
    error BadPermission(uint256 index);
    error NoStarterCaveat(uint256 index);
    error StepFailed(uint256 index, bytes reason);
    error TransferFailed(address token);

    event Run(address indexed starter, Lender lender, address token, uint256 amount, uint256 steps);

    constructor(address delegationManager_, address argsEnforcer_) {
        delegationManager = delegationManager_;
        argsEnforcer = argsEnforcer_;
    }

    receive() external payable {}

    /// @param lender None for no flash loan, Morpho (no fee) or AaveV3 (Pool.flashLoanSimple, with its premium).
    /// @param pool The Morpho or Aave v3 Pool contract.
    /// @param token The token to borrow. @param amount The amount to borrow.
    /// @param steps The steps, in order. With a flash loan they run inside the callback, and the loan is repaid after them.
    /// @param sweep Tokens to send in full to `recipient` at the end. address(0) means the native token.
    function run(
        Lender lender,
        address pool,
        address token,
        uint256 amount,
        Step[] calldata steps,
        address[] calldata sweep,
        address recipient
    ) external payable {
        if (_starter != address(0)) revert Busy();
        _starter = msg.sender;

        if (lender == Lender.None) {
            _runSteps(steps);
        } else {
            _lender = pool;
            _token = token;
            bytes memory data = abi.encode(steps);
            if (lender == Lender.Morpho) IMorpho(pool).flashLoan(token, amount, data);
            else IAavePool(pool).flashLoanSimple(address(this), token, amount, data, 0);
            _lender = address(0);
            _token = address(0);
        }

        for (uint256 i; i < sweep.length; ++i) {
            if (sweep[i] == address(0)) {
                uint256 bal = address(this).balance;
                if (bal > 0) {
                    (bool ok,) = recipient.call{value: bal}("");
                    if (!ok) revert TransferFailed(address(0));
                }
            } else {
                uint256 bal = IERC20(sweep[i]).balanceOf(address(this));
                if (bal > 0) _call(sweep[i], abi.encodeWithSelector(IERC20.transfer.selector, recipient, bal));
            }
        }

        emit Run(msg.sender, lender, token, amount, steps.length);
        _starter = address(0);
    }

    /// @notice Morpho callback. Morpho pulls `assets` back after it.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != _lender || _lender == address(0)) revert NotLender();
        _runSteps(abi.decode(data, (Step[])));
        _call(_token, abi.encodeWithSelector(IERC20.approve.selector, msg.sender, assets));
    }

    /// @notice Aave v3 callback. The Pool pulls `amount + premium` back after it.
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool)
    {
        if (msg.sender != _lender || _lender == address(0) || initiator != address(this)) revert NotLender();
        _runSteps(abi.decode(params, (Step[])));
        _call(asset, abi.encodeWithSelector(IERC20.approve.selector, msg.sender, amount + premium));
        return true;
    }

    function _runSteps(Step[] memory steps) private {
        for (uint256 i; i < steps.length; ++i) {
            Step memory s = steps[i];
            if (s.wallet == address(0)) {
                // A step from this contract cannot pull tokens of another address, and cannot redeem a permission unchecked.
                if (s.target == delegationManager || s.target == PERMIT2 || _selector(s.data) == TRANSFER_FROM) {
                    revert ForbiddenCall(i);
                }
                (bool ok, bytes memory ret) = s.target.call{value: s.value}(s.data);
                if (!ok) revert StepFailed(i, ret);
            } else {
                Delegation[] memory ds = abi.decode(s.permission, (Delegation[]));
                if (ds.length != 1 || ds[0].delegator != s.wallet || ds[0].delegate != address(this)) revert BadPermission(i);
                bool found;
                Caveat[] memory cs = ds[0].caveats;
                for (uint256 j; j < cs.length; ++j) {
                    if (cs[j].enforcer == argsEnforcer) {
                        cs[j].args = abi.encode(_starter);
                        found = true;
                    }
                }
                if (!found) revert NoStarterCaveat(i);

                bytes[] memory contexts = new bytes[](1);
                contexts[0] = abi.encode(ds);
                bytes32[] memory modes = new bytes32[](1); // single call, default execution type
                bytes[] memory executions = new bytes[](1);
                executions[0] = abi.encodePacked(s.target, s.value, s.data);
                (bool ok, bytes memory ret) = delegationManager.call(
                    abi.encodeWithSelector(IDelegationManager.redeemDelegations.selector, contexts, modes, executions)
                );
                if (!ok) revert StepFailed(i, ret);
            }
        }
    }

    /// @dev A token call that accepts a token with no return value (USDT).
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed(token);
    }

    function _selector(bytes memory data) private pure returns (bytes4 sel) {
        if (data.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(data, 32))
        }
    }
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function approve(address, uint256) external returns (bool);
}

interface IMorpho {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IAavePool {
    function flashLoanSimple(address receiver, address asset, uint256 amount, bytes calldata params, uint16 referralCode)
        external;
}

interface IDelegationManager {
    function redeemDelegations(bytes[] calldata contexts, bytes32[] calldata modes, bytes[] calldata executions) external;
}
