import { CommunityOracle } from './community/community_oracle';
import { DrivePrivacy, extToMime, GQLTagInterface, winstonToAr } from 'ardrive-core-js';
import * as fs from 'fs';
import { ArFSDAOType, ArFSDAOAnonymous, ArFSPublicDrive, ArFSDAO, ArFSPrivateDrive } from './arfsdao';
import { TransactionID, ArweaveAddress, Winston, DriveID, FolderID, Bytes, TipType, FeeMultiple } from './types';
import { WalletDAO, Wallet, JWKWallet } from './wallet_new';
import { ARDataPriceRegressionEstimator } from './utils/ar_data_price_regression_estimator';
import { ARDataPriceEstimator } from './utils/ar_data_price_estimator';
import {
	ArFSDriveTransactionData,
	ArFSFolderTransactionData,
	ArFSObjectTransactionData,
	ArFSPrivateDriveTransactionData,
	ArFSPrivateFileMetadataTransactionData,
	ArFSPrivateFolderTransactionData,
	ArFSPublicDriveTransactionData,
	ArFSPublicFileMetadataTransactionData,
	ArFSPublicFolderTransactionData
} from './arfs_trx_data_types';
import { basename } from 'path';

export type ArFSEntityDataType = 'drive' | 'folder' | 'file';

export interface ArFSEntityData {
	type: ArFSEntityDataType;
	metadataTxId: TransactionID;
	key?: string;
}

export interface TipData {
	txId: TransactionID;
	recipient: ArweaveAddress;
	winston: Winston;
}

export interface TipResult {
	tipData: TipData;
	reward: Winston;
}

export type ArFSFees = { [key: string]: number };

export interface ArFSResult {
	created: ArFSEntityData[];
	tips: TipData[];
	fees: ArFSFees;
}

export interface FolderUploadBaseCosts {
	metaDataBaseReward: Winston;
}

export interface FileUploadBaseCosts extends FolderUploadBaseCosts {
	fileDataBaseReward: Winston;
	communityWinstonTip: Winston;
}

export interface DriveUploadBaseCosts {
	driveMetaDataBaseReward: Winston;
	rootFolderMetaDataBaseReward: Winston;
}

const stubTransactionID = '0000000000000000000000000000000000000000000';
const stubEntityID = '00000000-0000-0000-0000-000000000000';

export abstract class ArDriveType {
	protected abstract readonly arFsDao: ArFSDAOType;
}

export class ArDriveAnonymous extends ArDriveType {
	constructor(protected readonly arFsDao: ArFSDAOAnonymous) {
		super();
	}

	async getPublicDrive(driveId: DriveID): Promise<ArFSPublicDrive> {
		const driveEntity = await this.arFsDao.getPublicDrive(driveId);
		return Promise.resolve(driveEntity);
	}
}

export class ArDrive extends ArDriveAnonymous {
	constructor(
		private readonly wallet: Wallet,
		private readonly walletDao: WalletDAO,
		protected readonly arFsDao: ArFSDAO,
		private readonly communityOracle: CommunityOracle,
		private readonly appName: string,
		private readonly appVersion: string,
		private readonly priceEstimator: ARDataPriceEstimator = new ARDataPriceRegressionEstimator(true),
		private readonly feeMultiple: FeeMultiple = 1.0
	) {
		super(arFsDao);
	}

	// TODO: FS shouldn't be reading the files more than once and doesn't belong in this class
	getFileSize(filePath: string): Bytes {
		return fs.statSync(filePath).size;
	}

	// NOTE: Presumes that there's a sufficient wallet balance
	async sendCommunityTip(communityWinstonTip: Winston): Promise<TipResult> {
		const tokenHolder: ArweaveAddress = await this.communityOracle.selectTokenHolder();
		const arTransferBaseFee = await this.priceEstimator.getBaseWinstonPriceForByteCount(0);

		const transferResult = await this.walletDao.sendARToAddress(
			winstonToAr(+communityWinstonTip),
			this.wallet,
			tokenHolder,
			{ reward: arTransferBaseFee.toString(), feeMultiple: this.feeMultiple },
			this.getTipTags()
		);

		return {
			tipData: { txId: transferResult.trxID, recipient: tokenHolder, winston: communityWinstonTip },
			reward: transferResult.reward
		};
	}

	getTipTags(tipType: TipType = 'data upload'): GQLTagInterface[] {
		return [
			{ name: 'App-Name', value: this.appName },
			{ name: 'App-Version', value: this.appVersion },
			{ name: 'Tip-Type', value: tipType }
		];
	}

	async uploadPublicFile(
		parentFolderId: FolderID,
		filePath: string,
		destinationFileName?: string
	): Promise<ArFSResult> {
		// TODO: Hoist this elsewhere for bulk uploads
		const uploadBaseCosts = await this.estimateAndAssertCostOfFileUpload(
			this.getFileSize(filePath),
			this.stubPublicFileMetadata(filePath, destinationFileName),
			'public'
		);

		// TODO: Add interactive confirmation of AR price estimation
		const fileDataRewardSettings = { reward: uploadBaseCosts.fileDataBaseReward, feeMultiple: this.feeMultiple };
		const metadataRewardSettings = { reward: uploadBaseCosts.metaDataBaseReward, feeMultiple: this.feeMultiple };
		const uploadFileResult = await this.arFsDao.uploadPublicFile(
			parentFolderId,
			filePath,
			fileDataRewardSettings,
			metadataRewardSettings,
			destinationFileName
		);
		const { tipData, reward: communityTipTrxReward } = await this.sendCommunityTip(
			uploadBaseCosts.communityWinstonTip
		);

		return Promise.resolve({
			created: [
				{
					type: 'file',
					metadataTxId: uploadFileResult.metaDataTrxId,
					dataTxId: uploadFileResult.dataTrxId,
					entityId: uploadFileResult.fileId
				}
			],
			tips: [tipData],
			fees: {
				[uploadFileResult.metaDataTrxId]: +uploadFileResult.metaDataTrxReward,
				[uploadFileResult.dataTrxId]: +uploadFileResult.dataTrxReward,
				[tipData.txId]: +communityTipTrxReward
			}
		});
	}

	/** Computes the size of a private file encrypted with AES256-GCM */
	encryptedDataSize(dataSize: number): number {
		return (dataSize / 16 + 1) * 16;
	}

	async uploadPrivateFile(
		parentFolderId: FolderID,
		filePath: string,
		password: string,
		destinationFileName?: string
	): Promise<ArFSResult> {
		// TODO: Hoist this elsewhere for bulk uploads
		const uploadBaseCosts = await this.estimateAndAssertCostOfFileUpload(
			this.getFileSize(filePath),
			await this.stubPrivateFileMetadata(filePath, destinationFileName),
			'private'
		);

		// TODO: Add interactive confirmation of AR price estimation

		const fileDataRewardSettings = { reward: uploadBaseCosts.fileDataBaseReward, feeMultiple: this.feeMultiple };
		const metadataRewardSettings = { reward: uploadBaseCosts.metaDataBaseReward, feeMultiple: this.feeMultiple };
		const uploadFileResult = await this.arFsDao.uploadPrivateFile(
			parentFolderId,
			filePath,
			password,
			fileDataRewardSettings,
			metadataRewardSettings,
			destinationFileName
		);

		const { tipData, reward: communityTipTrxReward } = await this.sendCommunityTip(
			uploadBaseCosts.communityWinstonTip
		);

		return Promise.resolve({
			created: [
				{
					type: 'file',
					metadataTxId: uploadFileResult.metaDataTrxId,
					dataTxId: uploadFileResult.dataTrxId,
					entityId: uploadFileResult.fileId,
					key: uploadFileResult.fileKey.toString('hex')
				}
			],
			tips: [tipData],
			fees: {
				[uploadFileResult.metaDataTrxId]: +uploadFileResult.metaDataTrxReward,
				[uploadFileResult.dataTrxId]: +uploadFileResult.dataTrxReward,
				[tipData.txId]: +communityTipTrxReward
			}
		});
	}

	async createPublicFolder(folderName: string, driveId: string, parentFolderId?: FolderID): Promise<ArFSResult> {
		// Assert that there's enough AR available in the wallet
		const folderData = new ArFSPublicFolderTransactionData(folderName);
		const { metaDataBaseReward } = await this.estimateAndAssertCostOfFolderUpload(folderData);

		// Create the folder and retrieve its folder ID
		const { folderTrxId, folderTrxReward, folderId } = await this.arFsDao.createPublicFolder({
			folderData,
			driveId,
			rewardSettings: { reward: metaDataBaseReward, feeMultiple: this.feeMultiple },
			parentFolderId
		});

		// IN THE FUTURE WE MIGHT SEND A COMMUNITY TIP HERE
		return Promise.resolve({
			created: [
				{
					type: 'folder',
					metadataTxId: folderTrxId,
					entityId: folderId
				}
			],
			tips: [],
			fees: {
				[folderTrxId]: +folderTrxReward
			}
		});
	}

	async createPublicDrive(driveName: string): Promise<ArFSResult> {
		// Assert that there's enough AR available in the wallet
		// Use stub data to estimate costs since actual data requires entity IDs generated by ArFSDao
		const stubRootFolderData = new ArFSPublicFolderTransactionData(driveName);
		const stubDriveData = new ArFSPublicDriveTransactionData(driveName, stubEntityID);
		const driveUploadCosts = await this.estimateAndAssertCostOfDriveCreation(stubDriveData, stubRootFolderData);
		const driveRewardSettings = {
			reward: driveUploadCosts.driveMetaDataBaseReward,
			feeMultiple: this.feeMultiple
		};
		const rootFolderRewardSettings = {
			reward: driveUploadCosts.rootFolderMetaDataBaseReward,
			feeMultiple: this.feeMultiple
		};
		const createDriveResult = await this.arFsDao.createPublicDrive(
			driveName,
			driveRewardSettings,
			rootFolderRewardSettings
		);
		return Promise.resolve({
			created: [
				{
					type: 'drive',
					metadataTxId: createDriveResult.driveTrxId,
					entityId: createDriveResult.driveId
				},
				{
					type: 'folder',
					metadataTxId: createDriveResult.rootFolderTrxId,
					entityId: createDriveResult.rootFolderId
				}
			],
			tips: [],
			fees: {
				[createDriveResult.driveTrxId]: +createDriveResult.driveTrxReward,
				[createDriveResult.rootFolderTrxId]: +createDriveResult.rootFolderTrxReward
			}
		});
	}

	async createPrivateDrive(driveName: string, password: string): Promise<ArFSResult> {
		// Assert that there's enough AR available in the wallet
		const wallet = this.wallet as JWKWallet;
		const privKey = wallet.getPrivateKey();
		const stubRootFolderData = await ArFSPrivateFolderTransactionData.from(
			driveName,
			stubEntityID,
			password,
			privKey
		);
		const stubDriveData = await ArFSPrivateDriveTransactionData.from(
			driveName,
			stubEntityID,
			stubEntityID,
			password,
			privKey
		);
		const driveCreationCosts = await this.estimateAndAssertCostOfDriveCreation(stubDriveData, stubRootFolderData);
		const driveRewardSettings = {
			reward: driveCreationCosts.driveMetaDataBaseReward,
			feeMultiple: this.feeMultiple
		};
		const rootFolderRewardSettings = {
			reward: driveCreationCosts.rootFolderMetaDataBaseReward,
			feeMultiple: this.feeMultiple
		};
		const createDriveResult = await this.arFsDao.createPrivateDrive(
			driveName,
			password,
			driveRewardSettings,
			rootFolderRewardSettings
		);

		// IN THE FUTURE WE MIGHT SEND A COMMUNITY TIP HERE
		return Promise.resolve({
			created: [
				{
					type: 'drive',
					metadataTxId: createDriveResult.driveTrxId,
					entityId: createDriveResult.driveId,
					key: createDriveResult.driveKey.toString('hex')
				},
				{
					type: 'folder',
					metadataTxId: createDriveResult.rootFolderTrxId,
					entityId: createDriveResult.rootFolderId,
					key: createDriveResult.driveKey.toString('hex')
				}
			],
			tips: [],
			fees: {
				[createDriveResult.driveTrxId]: +createDriveResult.driveTrxReward,
				[createDriveResult.rootFolderTrxId]: +createDriveResult.rootFolderTrxReward
			}
		});
	}

	async getPrivateDrive(driveId: DriveID, drivePassword: string): Promise<ArFSPrivateDrive> {
		const driveEntity = await this.arFsDao.getPrivateDrive(driveId, drivePassword);
		return Promise.resolve(driveEntity);
	}

	async estimateAndAssertCostOfFileUpload(
		decryptedFileSize: number,
		metaData: ArFSObjectTransactionData,
		drivePrivacy: DrivePrivacy
	): Promise<FileUploadBaseCosts> {
		if (decryptedFileSize < 0) {
			throw new Error('File size should be non-negative number!');
		}

		let fileSize = decryptedFileSize;
		if (drivePrivacy === 'private') {
			fileSize = this.encryptedDataSize(fileSize);
		}

		let totalPrice = 0;
		let fileDataBaseReward = 0;
		let communityWinstonTip = '0';
		if (fileSize) {
			fileDataBaseReward = await this.priceEstimator.getBaseWinstonPriceForByteCount(fileSize);
			communityWinstonTip = await this.communityOracle.getCommunityWinstonTip(fileDataBaseReward.toString());
			const tipReward = await this.priceEstimator.getBaseWinstonPriceForByteCount(0);
			totalPrice += fileDataBaseReward;
			totalPrice += +communityWinstonTip;
			totalPrice += tipReward;
		}
		const metaDataBaseReward = await this.priceEstimator.getBaseWinstonPriceForByteCount(metaData.sizeOf());
		totalPrice += metaDataBaseReward;

		const totalWinstonPrice = totalPrice.toString();

		const walletBalance = this.walletDao.getWalletWinstonBalance(this.wallet);
		if (!this.walletDao.walletHasBalance(this.wallet, totalWinstonPrice)) {
			throw new Error(
				`Wallet balance of ${walletBalance} Winston is not enough (${totalWinstonPrice}) for data upload of size ${fileSize} bytes!`
			);
		}

		return {
			fileDataBaseReward: fileDataBaseReward.toString(),
			metaDataBaseReward: metaDataBaseReward.toString(),
			communityWinstonTip
		};
	}

	async estimateAndAssertCostOfFolderUpload(metaData: ArFSObjectTransactionData): Promise<FolderUploadBaseCosts> {
		const metaDataBaseReward = await this.priceEstimator.getBaseWinstonPriceForByteCount(metaData.sizeOf());
		const totalWinstonPrice = metaDataBaseReward.toString();

		const walletBalance = this.walletDao.getWalletWinstonBalance(this.wallet);
		if (!this.walletDao.walletHasBalance(this.wallet, totalWinstonPrice)) {
			throw new Error(
				`Wallet balance of ${walletBalance} Winston is not enough (${totalWinstonPrice}) for folder creation!`
			);
		}

		return {
			metaDataBaseReward: totalWinstonPrice
		};
	}

	async estimateAndAssertCostOfDriveCreation(
		driveMetaData: ArFSDriveTransactionData,
		rootFolderMetaData: ArFSFolderTransactionData
	): Promise<DriveUploadBaseCosts> {
		let totalPrice = 0;
		const driveMetaDataBaseReward = await this.priceEstimator.getBaseWinstonPriceForByteCount(
			driveMetaData.sizeOf()
		);
		totalPrice += driveMetaDataBaseReward;
		const rootFolderMetaDataBaseReward = await this.priceEstimator.getBaseWinstonPriceForByteCount(
			rootFolderMetaData.sizeOf()
		);
		totalPrice += rootFolderMetaDataBaseReward;

		const totalWinstonPrice = totalPrice.toString();

		if (!this.walletDao.walletHasBalance(this.wallet, totalWinstonPrice)) {
			const walletBalance = this.walletDao.getWalletWinstonBalance(this.wallet);
			throw new Error(
				`Wallet balance of ${walletBalance} Winston is not enough (${totalPrice}) for drive creation!`
			);
		}

		return {
			driveMetaDataBaseReward: driveMetaDataBaseReward.toString(),
			rootFolderMetaDataBaseReward: rootFolderMetaDataBaseReward.toString()
		};
	}

	// Provides for stubbing metadata during cost estimations since the data trx ID won't yet be known
	private stubPublicFileMetadata(
		filePath: string,
		destinationFileName?: string
	): ArFSPublicFileMetadataTransactionData {
		const fileStats = fs.statSync(filePath);
		const dataContentType = extToMime(filePath);
		const lastModifiedDateMS = Math.floor(fileStats.mtimeMs);
		return new ArFSPublicFileMetadataTransactionData(
			destinationFileName ?? basename(filePath),
			fileStats.size,
			lastModifiedDateMS,
			stubTransactionID,
			dataContentType
		);
	}

	// Provides for stubbing metadata during cost estimations since the data trx and File IDs won't yet be known
	private async stubPrivateFileMetadata(
		filePath: string,
		destinationFileName?: string
	): Promise<ArFSPrivateFileMetadataTransactionData> {
		const fileStats = fs.statSync(filePath);
		const dataContentType = extToMime(filePath);
		const lastModifiedDateMS = Math.floor(fileStats.mtimeMs);
		return await ArFSPrivateFileMetadataTransactionData.from(
			destinationFileName ?? basename(filePath),
			fileStats.size,
			lastModifiedDateMS,
			stubTransactionID,
			dataContentType,
			stubEntityID,
			stubEntityID,
			'stubPassword',
			(this.wallet as JWKWallet).getPrivateKey()
		);
	}
}
