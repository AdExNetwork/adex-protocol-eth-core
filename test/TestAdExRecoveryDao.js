const { providers, Contract } = require('ethers')
const { Interface } = require('ethers').utils

const {
	expectEVMError /* , setTime */,
	moveTime,
	takeSnapshot,
	revertToSnapshot,
	NULL_ADDRESS
} = require('./')
const { Transaction } = require('../js')

const AdExRecoveryDAO = artifacts.require('AdExRecoveryDAO')
const Identity = artifacts.require('Identity')

const web3Provider = new providers.Web3Provider(web3.currentProvider)

contract('AdExRecoveryDAO', function(accounts) {
	const admin = accounts[1]
	const anotherUser = accounts[2]
	const anotherUser1 = accounts[3]
	const anotherProposerAccount = accounts[4]
	const newUserWallet = accounts[5]
	const identityWallet = accounts[6]

	const adminSigner = web3Provider.getSigner(admin)
	const anotherSigner = web3Provider.getSigner(anotherUser)
	const anotherProposerAccountSigner = web3Provider.getSigner(anotherProposerAccount)
	const identityWalletSigner = web3Provider.getSigner(identityWallet)

	const recoveryDAOInterface = new Interface(AdExRecoveryDAO._json.abi)

	let adxRecoveryDAO
	// identity account that will be used for all identity interactions
	let userIdentityAccount
	let id

	let snapshotId

	const sampleRecoveryRequestProposal = () => [userIdentityAccount.address, newUserWallet]

	before(async function() {
		const minDelay = 3
		const delay = 3
		const adxRecoveryDAOWeb3 = await AdExRecoveryDAO.new(admin, minDelay, delay)
		adxRecoveryDAO = new Contract(
			adxRecoveryDAOWeb3.address,
			AdExRecoveryDAO._json.abi,
			adminSigner
		)
		// for the identity we want to give the
		// AdExRecoveryDao contract a Transaction PrivilegeLevel
		// to enable it recover the account
		userIdentityAccount = await Identity.new([adxRecoveryDAOWeb3.address, identityWallet], [2, 2])
		id = new Contract(userIdentityAccount.address, Identity._json.abi, identityWalletSigner)
	})

	beforeEach(async function() {
		snapshotId = await takeSnapshot(web3)
	})

	// eslint-disable-next-line no-undef
	afterEach(async function() {
		await revertToSnapshot(web3, snapshotId)
	})

	it('reject invalid constructor params', async function() {
		await expectEVMError(
			AdExRecoveryDAO.new(admin, 0, 3),
			'INVALID_MIN_DELAY -- Reason given: INVALID_MIN_DELAY.',
			'Returned error: '
		)
		await expectEVMError(
			AdExRecoveryDAO.new(admin, 3, 0),
			'INVALID_DELAY -- Reason given: INVALID_DELAY.',
			'Returned error: '
		)
		await expectEVMError(
			AdExRecoveryDAO.new(NULL_ADDRESS, 3, 3),
			'INVALID_ADMIN -- Reason given: INVALID_ADMIN.',
			'Returned error: '
		)
	})

	it('only admin can add proposer', async function() {
		await expectEVMError(
			adxRecoveryDAO.connect(anotherSigner).addProposer(anotherUser),
			'ONLY_ADMIN_CAN_ADD_PROPOSER'
		)
		await (await adxRecoveryDAO.addProposer(anotherUser1)).wait()
		assert.deepEqual(await adxRecoveryDAO.proposers(anotherUser1), true, 'should add proposer')
	})

	it('only admin can change recovery delay', async function() {
		await expectEVMError(
			adxRecoveryDAO.connect(anotherSigner).changeRecoveryDelay(10),
			'ONLY_ADMIN_CAN_CALL'
		)
		await (await adxRecoveryDAO.changeRecoveryDelay(10)).wait()
		assert.deepEqual(
			(await adxRecoveryDAO.recoveryDelay()).toNumber(),
			10,
			'should change recoveryDelay'
		)
	})

	it('admin can not set recovery delay below minimum', async function() {
		await expectEVMError(adxRecoveryDAO.changeRecoveryDelay(1), 'NEW_DELAY_BELOW_MINIMUM')
		assert.deepEqual(
			(await adxRecoveryDAO.recoveryDelay()).toNumber(),
			3,
			'should not change the recoveryDelay'
		)
	})

	it('only admin can remove proposer', async function() {
		await expectEVMError(
			adxRecoveryDAO.connect(anotherSigner).removeProposer(anotherUser1),
			'ONLY_ADMIN_CAN_REMOVE_PROPOSER'
		)
		await (await adxRecoveryDAO.addProposer(anotherUser1)).wait()
		await (await adxRecoveryDAO.removeProposer(anotherUser1)).wait()
		assert.deepEqual(await adxRecoveryDAO.proposers(anotherUser1), false, 'should remove proposer')
	})

	it('only admin can change admin', async function() {
		await expectEVMError(
			adxRecoveryDAO.connect(anotherSigner).changeAdmin(anotherProposerAccount),
			'ONLY_ADMIN_CAN_CALL'
		)
		await expectEVMError(adxRecoveryDAO.changeAdmin(admin), 'INVALID_NEW_ADMIN')
		await adxRecoveryDAO.changeAdmin(anotherProposerAccount)
		assert.deepEqual(
			await adxRecoveryDAO.adminAddr(),
			anotherProposerAccount,
			'should change admin'
		)
	})

	it('only proposers can propose recovery', async function() {
		await (await adxRecoveryDAO.addProposer(anotherProposerAccount)).wait()

		const recoveryProposal = sampleRecoveryRequestProposal()

		await expectEVMError(
			adxRecoveryDAO.connect(anotherSigner).proposeRecovery(recoveryProposal),
			'ONLY_WHITELISTED_PROPOSER'
		)

		const recoveryTx = await (await adxRecoveryDAO
			.connect(anotherProposerAccountSigner)
			.proposeRecovery(recoveryProposal)).wait()

		assert.ok(
			recoveryTx.events.find(x => x.event === 'LogProposeRecovery'),
			'should propose recovery'
		)
	})

	it('only admin, identity being recovered or proposer can cancel recovery request', async function() {
		await (await adxRecoveryDAO.addProposer(anotherProposerAccount)).wait()

		const recoveryProposal = sampleRecoveryRequestProposal()
		// propose recovery
		await (await adxRecoveryDAO
			.connect(anotherProposerAccountSigner)
			.proposeRecovery(recoveryProposal)).wait()

		await expectEVMError(
			adxRecoveryDAO.connect(anotherSigner).cancelRecovery(recoveryProposal),
			'ONLY_IDENTITY_PROPOSER_OR_ADMIN_CAN_CANCEL'
		)
	})

	it('can not cancel non existing recovery request', async function() {
		await (await adxRecoveryDAO.addProposer(anotherProposerAccount)).wait()

		await expectEVMError(
			adxRecoveryDAO.cancelRecovery([userIdentityAccount.address, admin]),
			'RECOVERY_REQUEST_DOES_NOT_EXIST'
		)
	})

	it('admin can cancel recovery', async function() {
		await (await adxRecoveryDAO.addProposer(anotherProposerAccount)).wait()
		const recoveryProposal = sampleRecoveryRequestProposal()
		// propose recovery
		await (await adxRecoveryDAO
			.connect(anotherProposerAccountSigner)
			.proposeRecovery(recoveryProposal)).wait()
		// cancel recovery
		const cancelTx = await (await adxRecoveryDAO.cancelRecovery(recoveryProposal)).wait()
		assert.ok(cancelTx.events.find(x => x.event === 'LogCancelRecovery'), 'should cancel recovery')
	})

	it('any proposers can cancel recovery', async function() {
		await (await adxRecoveryDAO.addProposer(anotherProposerAccount)).wait()

		const recoveryProposal = sampleRecoveryRequestProposal()
		// propose recovery
		await (await adxRecoveryDAO
			.connect(anotherProposerAccountSigner)
			.proposeRecovery(recoveryProposal)).wait()

		// cancel recovery
		const cancelTx = await (await adxRecoveryDAO
			.connect(anotherProposerAccountSigner)
			.cancelRecovery(recoveryProposal)).wait()
		const ev = cancelTx.events.find(x => x.event === 'LogCancelRecovery')
		assert.ok(ev, 'should cancel recovery')
		assert.deepEqual(
			(await adxRecoveryDAO.recovery(ev.args.recoveryId)).toString(),
			'0',
			'should cancel recovery'
		)
	})

	it('user identity can cancel recovery', async function() {
		await (await adxRecoveryDAO.addProposer(anotherProposerAccount)).wait()
		const recoveryProposal = sampleRecoveryRequestProposal()
		// propose recovery
		const recoveryTx = await (await adxRecoveryDAO
			.connect(anotherProposerAccountSigner)
			.proposeRecovery(recoveryProposal)).wait()

		const recoveryTxEv = recoveryTx.events.find(x => x.event === 'LogProposeRecovery')
		assert.ok(recoveryTxEv, 'should have LogProposeRecovery')
		const initialNonce = (await id.nonce()).toNumber()

		const cancelRecoveryIdentityTx = new Transaction({
			identityContract: userIdentityAccount.address,
			nonce: initialNonce,
			feeTokenAddr: newUserWallet,
			feeAmount: 0,
			to: adxRecoveryDAO.address,
			data: recoveryDAOInterface.functions.cancelRecovery.encode([recoveryProposal])
		})

		// cancel recovery request via user identity
		await (await id.executeBySender([cancelRecoveryIdentityTx.toSolidityTuple()])).wait()
		// confirm if recovery is cancelled
		assert(await adxRecoveryDAO.recovery(recoveryTxEv.args.recoveryId), 0, 'should cancel recovery')
	})

	it('can not finalize non existing recovery request', async function() {
		await (await adxRecoveryDAO.addProposer(anotherProposerAccount)).wait()

		await expectEVMError(
			adxRecoveryDAO
				.connect(anotherProposerAccountSigner)
				.finalizeRecovery([userIdentityAccount.address, admin]),
			'RECOVERY_REQUEST_DOES_NOT_EXIST'
		)
	})

	it('only proposer can finalize recovery', async function() {
		await (await adxRecoveryDAO.addProposer(anotherProposerAccount)).wait()
		const recoveryProposal = sampleRecoveryRequestProposal()
		// propose recovery
		await (await adxRecoveryDAO
			.connect(anotherProposerAccountSigner)
			.proposeRecovery(recoveryProposal)).wait()

		await expectEVMError(
			adxRecoveryDAO.connect(anotherProposerAccountSigner).finalizeRecovery(recoveryProposal),
			'ACTIVE_DELAY'
		)

		await expectEVMError(
			adxRecoveryDAO.connect(anotherSigner).finalizeRecovery(recoveryProposal),
			'ONLY_WHITELISTED_PROPOSERS'
		)

		// ensure that we can finalize recovery
		await moveTime(web3, 20000)

		const finalizeRecoveryTx = await (await adxRecoveryDAO
			.connect(anotherProposerAccountSigner)
			.finalizeRecovery(recoveryProposal)).wait()

		assert(
			finalizeRecoveryTx.events.find(x => x.event === 'LogFinalizeRecovery'),
			'should finalize recovery'
		)

		// confirm new user wallet has the correct privilege level
		assert(id.privileges(newUserWallet), 2, 'new user wallet should have tx level')
	})
})
