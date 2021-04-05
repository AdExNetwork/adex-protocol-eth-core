const Migrations = artifacts.require('Migrations')
const OUTPACE = artifacts.require('OUTPACE')

module.exports = function(deployer) {
	deployer.deploy(OUTPACE)
	deployer.deploy(Migrations)
}
