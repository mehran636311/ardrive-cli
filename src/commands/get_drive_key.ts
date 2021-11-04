import { arDriveFactory } from '..';
import { CLICommand, ParametersHelper } from '../CLICommand';
import { CLIAction } from '../CLICommand/action';
import { DriveCreationPrivacyParameters, DriveIdParameter, NoVerifyParameter } from '../parameter_declarations';
import { EID } from '../types/entity_id';
import { urlEncodeHashKey } from '../utils';

new CLICommand({
	name: 'get-drive-key',
	parameters: [...DriveCreationPrivacyParameters, DriveIdParameter, NoVerifyParameter],
	action: new CLIAction(async function action(options) {
		const parameters = new ParametersHelper(options);
		const driveId = EID(parameters.getRequiredParameterValue(DriveIdParameter));
		const driveKey = await parameters.getDriveKey({ driveId });
		if (options.verify) {
			const arDrive = arDriveFactory({ wallet: await parameters.getRequiredWallet() });
			await arDrive.getPrivateDrive(driveId, driveKey);
		}
		console.log(urlEncodeHashKey(driveKey));
	})
});
